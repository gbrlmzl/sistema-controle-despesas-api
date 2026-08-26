import type { StoragePort } from '../../src/lib/storage.js';

// Fake em memória para os testes de acertos (Fase 4/8): nenhum deles abre conexão
// com a AWS. `simulateUpload` representa o passo 2 do fluxo de três passos (D-23) —
// o navegador postando direto no S3 — que nenhum teste automatizado atravessa de
// verdade.

export interface FakeStorage extends StoragePort {
  simulateUpload(key: string, body: Buffer, contentType: string): void;
}

export function createFakeStorage(): FakeStorage {
  const objects = new Map<string, { body: Buffer; contentType: string }>();

  return {
    async createUploadTicket({ key, contentType }) {
      return { url: 'https://fake-bucket.example.com', fields: { key, 'Content-Type': contentType } };
    },
    async headObject(key) {
      const obj = objects.get(key);
      return obj ? { contentType: obj.contentType, sizeInBytes: obj.body.length } : null;
    },
    async readFirstBytes(key, length) {
      const obj = objects.get(key);
      return obj ? obj.body.subarray(0, length) : null;
    },
    async createDownloadUrl({ key }) {
      return `https://fake-bucket.example.com/${encodeURIComponent(key)}?X-Amz-Fake=1`;
    },
    async deleteObject(key) {
      objects.delete(key);
    },
    simulateUpload(key, body, contentType) {
      objects.set(key, { body, contentType });
    },
  };
}

// Bytes de assinatura válidos por tipo (tabela em 02-pesquisa-amazon-s3-boas-praticas.md
// §6), usados para simular um upload que passa na checagem de magic bytes (D-23).
export const VALID_SIGNATURE_BYTES: Record<string, Buffer> = {
  'image/jpeg': Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]),
  'image/png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]),
  'image/webp': Buffer.concat([Buffer.from('RIFF', 'ascii'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBP', 'ascii')]),
  'application/pdf': Buffer.from('%PDF-1.7....', 'ascii'),
};

export const INVALID_SIGNATURE_BYTES = Buffer.from('não é uma imagem'.padEnd(12, ' '), 'ascii');
