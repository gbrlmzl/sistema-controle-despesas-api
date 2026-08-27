import {
  contentDisposition,
  uploadConditions,
  createDisabledStorage,
} from '../../src/lib/storage.js';
import { AppError } from '../../src/utils/AppError.js';

// D-24 -> Só o que é PURO é coberto aqui: a montagem das Conditions do presigned POST,
// o Content-Disposition por tipo, e que a implementação desligada lança 503. Nenhuma
// chamada de rede — a implementação de verdade (S3Client, createPresignedPost,
// getSignedUrl) nunca é exercitada em teste automatizado.

describe('uploadConditions (D-13)', () => {
  it('gera a única condição de content-length-range, de 1 até o teto informado', () => {
    expect(uploadConditions(5 * 1024 * 1024)).toEqual([['content-length-range', 1, 5 * 1024 * 1024]]);
  });
});

describe('contentDisposition (D-25)', () => {
  it('monta inline para imagem', () => {
    expect(contentDisposition('inline', 'comprovante.jpg')).toBe('inline; filename="comprovante.jpg"');
  });

  it('monta attachment para PDF', () => {
    expect(contentDisposition('attachment', 'comprovante.pdf')).toBe('attachment; filename="comprovante.pdf"');
  });

  it('escapa aspas e quebras de linha do nome do arquivo', () => {
    expect(contentDisposition('inline', 'foto"maliciosa\r\n.jpg')).toBe('inline; filename="fotomaliciosa.jpg"');
  });
});

describe('createDisabledStorage (D-18)', () => {
  const storage = createDisabledStorage();

  it('createUploadTicket lança 503', async () => {
    await expect(
      storage.createUploadTicket({ key: 'k', contentType: 'image/jpeg', maxSizeInBytes: 1, expiresInSeconds: 60 }),
    ).rejects.toMatchObject(new AppError(503, 'Armazenamento de comprovantes indisponível.'));
  });

  it('headObject lança 503', async () => {
    await expect(storage.headObject('k')).rejects.toBeInstanceOf(AppError);
  });

  it('readFirstBytes lança 503', async () => {
    await expect(storage.readFirstBytes('k', 12)).rejects.toBeInstanceOf(AppError);
  });

  it('createDownloadUrl lança 503', async () => {
    await expect(
      storage.createDownloadUrl({
        key: 'k',
        expiresInSeconds: 60,
        contentType: 'image/jpeg',
        disposition: 'inline',
        fileName: 'a.jpg',
      }),
    ).rejects.toBeInstanceOf(AppError);
  });

  it('deleteObject lança 503', async () => {
    await expect(storage.deleteObject('k')).rejects.toBeInstanceOf(AppError);
  });
});
