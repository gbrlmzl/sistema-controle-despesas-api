// D-24 -> O armazenamento de comprovantes é uma porta (StoragePort), não uma dependência
// direta importada pelos services — mesmo padrão de mailer.ts (SendEmail). Ganho
// principal: nenhum teste automatizado abre conexão com a AWS (Regra 5 da Parte B); os
// testes injetam um fake em memória, e o CI continua verde sem segredo nenhum, do mesmo
// jeito que googleAuthEnabled e mailEnabled já garantem.

import {
  S3Client,
  PutObjectCommand,
  HeadObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  type HeadObjectCommandOutput,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { createPresignedPost } from '@aws-sdk/s3-presigned-post';
import { env, storageEnabled } from '../config/env.js';
import { AppError } from '../utils/AppError.js';

export interface UploadTicket {
  url: string;
  fields: Record<string, string>;
}

export interface StoredObjectInfo {
  contentType: string | null;
  sizeInBytes: number;
}

export interface StoragePort {
  createUploadTicket(input: {
    key: string;
    contentType: string;
    maxSizeInBytes: number;
    expiresInSeconds: number;
  }): Promise<UploadTicket>;

  // Devolve null quando o objeto não existe. Ver nota sobre 403 abaixo.
  headObject(key: string): Promise<StoredObjectInfo | null>;

  // Lê só os primeiros bytes (Range), para conferir a assinatura do arquivo (D-23).
  readFirstBytes(key: string, length: number): Promise<Buffer | null>;

  createDownloadUrl(input: {
    key: string;
    expiresInSeconds: number;
    contentType: string;
    disposition: 'inline' | 'attachment';
    fileName: string;
  }): Promise<string>;

  deleteObject(key: string): Promise<void>;
}

// Um S3Client só, no escopo do módulo: criar um por requisição desperdiça o pool de
// conexões HTTP que o SDK mantém internamente.
function createS3Client(): S3Client {
  return new S3Client({
    region: env.S3_REGION,
    // S3_ENDPOINT, se presente, aponta a um S3 compatível (MinIO/LocalStack), que exige
    // path-style (bucket.exemplo.com/key não funciona nesses serviços — D-14).
    ...(env.S3_ENDPOINT !== undefined && { endpoint: env.S3_ENDPOINT, forcePathStyle: true }),
    // Credencial explícita SÓ se as duas variáveis existirem. Caso contrário, não passe
    // a opção — deixe o SDK resolver pela provider chain, que é assim que a role da task
    // do ECS entra em produção (nunca uma chave de acesso longa lá).
    ...(env.S3_ACCESS_KEY_ID !== undefined &&
      env.S3_SECRET_ACCESS_KEY !== undefined && {
        credentials: {
          accessKeyId: env.S3_ACCESS_KEY_ID,
          secretAccessKey: env.S3_SECRET_ACCESS_KEY,
        },
      }),
  });
}

// Content-Disposition com o nome de arquivo escapado: um nome com aspas quebraria o
// cabeçalho (e um nome com CRLF permitiria injetar cabeçalho — defesa em profundidade).
// Pura e exportada para o teste unitário (tests/unit/storage.test.ts) exercitar sem
// tocar o SDK da AWS.
export function contentDisposition(disposition: 'inline' | 'attachment', fileName: string): string {
  const escaped = fileName.replace(/["\r\n]/g, '');
  return `${disposition}; filename="${escaped}"`;
}

// D-13 -> A única condição que não é automática no presigned POST: o pacote já cobre a
// igualdade de `key` e de cada entrada de `Fields` sozinho (ver comentário em
// createUploadTicket), mas o teto de tamanho só existe se for declarado aqui — é a
// única forma de o S3 recusar sozinho um arquivo grande demais. Pura e exportada pelo
// mesmo motivo de contentDisposition acima.
export function uploadConditions(maxSizeInBytes: number): Array<['content-length-range', number, number]> {
  return [['content-length-range', 1, maxSizeInBytes]];
}

function createS3Storage(): StoragePort {
  const client = createS3Client();

  return {
    async createUploadTicket({ key, contentType, maxSizeInBytes, expiresInSeconds }) {
      // D-13 -> Presigned POST, não PUT: só o POST aceita `content-length-range` como
      // condição da política, que é a única forma de o S3 recusar sozinho um arquivo
      // grande demais, sem a API precisar carregar o corpo na memória.
      //
      // O pacote já resolve sozinho três coisas que não devem ser repetidas aqui: ele
      // acrescenta `{ key: Key }` à política como igualdade exata (redundante escrever
      // de novo em Conditions), acrescenta uma igualdade exata para cada entrada de
      // `Fields` (então `Fields: { 'Content-Type': ... }` já é a trava de tipo), e
      // devolve em `fields` tudo que o formulário precisa (key, bucket, Policy,
      // X-Amz-Signature, e X-Amz-Security-Token quando a credencial é temporária).
      const { url, fields } = await createPresignedPost(client, {
        Bucket: env.S3_BUCKET!,
        Key: key,
        Expires: expiresInSeconds,
        Fields: { 'Content-Type': contentType },
        Conditions: uploadConditions(maxSizeInBytes),
      });
      return { url, fields };
    },

    async headObject(key) {
      try {
        const out: HeadObjectCommandOutput = await client.send(
          new HeadObjectCommand({ Bucket: env.S3_BUCKET!, Key: key }),
        );
        return { contentType: out.ContentType ?? null, sizeInBytes: out.ContentLength ?? 0 };
      } catch (err) {
        // A política IAM (§A.3) não concede s3:ListBucket de propósito (menor
        // privilégio). Efeito colateral: pedir um objeto que não existe devolve 403
        // AccessDenied, não 404 NoSuchKey. Os dois significam "não encontrado" aqui —
        // sem tratar o 403 também, o fluxo de confirmação quebra para todo objeto
        // inexistente, não só para os que realmente faltam permissão.
        const statusCode = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
        if (statusCode === 404 || statusCode === 403) return null;
        throw err;
      }
    },

    async readFirstBytes(key, length) {
      try {
        const out = await client.send(
          new GetObjectCommand({ Bucket: env.S3_BUCKET!, Key: key, Range: `bytes=0-${length - 1}` }),
        );
        if (!out.Body) return null;
        return Buffer.from(await out.Body.transformToByteArray());
      } catch (err) {
        const statusCode = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
        if (statusCode === 404 || statusCode === 403) return null;
        throw err;
      }
    },

    async createDownloadUrl({ key, expiresInSeconds, contentType, disposition, fileName }) {
      // D-25 -> URL pré-assinada emitida sob demanda, nunca guardada. Os headers de
      // resposta são forçados aqui: imagem sai inline, PDF sai attachment.
      const command = new GetObjectCommand({
        Bucket: env.S3_BUCKET!,
        Key: key,
        ResponseContentType: contentType,
        ResponseContentDisposition: contentDisposition(disposition, fileName),
      });
      return getSignedUrl(client, command, { expiresIn: expiresInSeconds });
    },

    async deleteObject(key) {
      // D-26 -> Com o bucket versionado (D-16), isto cria um delete marker em vez de
      // apagar de verdade: nem um bug nem uma credencial comprometida destroem um
      // comprovante de forma irreversível.
      await client.send(new DeleteObjectCommand({ Bucket: env.S3_BUCKET!, Key: key }));
    },
  };
}

// D-18 -> Sem S3_REGION + S3_BUCKET, nenhuma operação de storage deve rodar. Falha
// sempre com 503, nunca em silêncio — um upload que "funciona" sem gravar nada seria
// pior que a funcionalidade simplesmente ausente. Exportada para o teste unitário.
export function createDisabledStorage(): StoragePort {
  const unavailable = (): never => {
    throw new AppError(503, 'Armazenamento de comprovantes indisponível.');
  };
  return {
    createUploadTicket: async () => unavailable(),
    headObject: async () => unavailable(),
    readFirstBytes: async () => unavailable(),
    createDownloadUrl: async () => unavailable(),
    deleteObject: async () => unavailable(),
  };
}

const realStorage: StoragePort = storageEnabled ? createS3Storage() : createDisabledStorage();

let activeStorage: StoragePort = realStorage;

// `storage` em si é uma referência estável (quem importou já tem o objeto), mas o
// que cada método FAZ pode ser trocado — mesmo padrão de sendEmail em mailer.ts.
// Sem isto, os testes de settlementsService (Fase 4) e a suíte de integração
// (Fase 8) só teriam dois jeitos de exercitar upload/leitura de comprovante: abrir
// conexão de verdade com a AWS, ou não testar esse caminho nenhum — os dois errados
// para `npm test` (Regra 5 da Parte B: nenhum teste automatizado abre conexão com
// a AWS).
export const storage: StoragePort = {
  createUploadTicket: (input) => activeStorage.createUploadTicket(input),
  headObject: (key) => activeStorage.headObject(key),
  readFirstBytes: (key, length) => activeStorage.readFirstBytes(key, length),
  createDownloadUrl: (input) => activeStorage.createDownloadUrl(input),
  deleteObject: (key) => activeStorage.deleteObject(key),
};

// Gancho de teste: troca a implementação ativa por um fake em memória. Chamar com
// `null` restaura a implementação real (S3 ou desabilitada, conforme storageEnabled).
export function setStorageForTests(fake: StoragePort | null): void {
  activeStorage = fake ?? realStorage;
}

// Exportada só para o script de teste manual (scripts/testStorage.ts) escrever um
// objeto de verdade antes de exercitar o resto da porta — não faz parte da interface
// pública usada pelos services.
export async function putTestObject(key: string, body: Buffer, contentType: string): Promise<void> {
  if (!storageEnabled) throw new AppError(503, 'Armazenamento de comprovantes indisponível.');
  const client = createS3Client();
  await client.send(new PutObjectCommand({ Bucket: env.S3_BUCKET!, Key: key, Body: body, ContentType: contentType }));
}
