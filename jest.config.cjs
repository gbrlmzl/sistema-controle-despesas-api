/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  // O projeto é ESM de verdade (package.json "type": "module", exigência do
  // client novo do Prisma — ver memória do projeto). Rodar o Jest em modo ESM
  // nativo em vez de fingir CommonJS evita ter que "consertar" cada arquivo do
  // node_modules que usa import/export real (ex.: o compilador de queries WASM
  // do Prisma 7).
  extensionsToTreatAsEsm: ['.ts'],
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
  collectCoverageFrom: ['src/**/*.ts', '!src/generated/**', '!src/types/**'],
  coverageDirectory: '<rootDir>/coverage',
};
