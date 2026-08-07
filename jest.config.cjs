/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  transform: {
    '^.+\\.ts$': 'babel-jest',
  },
  // As fontes usam extensão .js nos imports relativos (exigência do NodeNext/ESM,
  // apontando pro .js que o tsc vai gerar) mas o Jest roda direto sobre os .ts —
  // sem isso ele procura um arquivo .js que não existe.
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  testMatch: ['<rootDir>/tests/**/*.test.ts'],
};
