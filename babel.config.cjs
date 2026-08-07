module.exports = {
  presets: [
    // modules: false -> mantém import/export nativos em vez de converter pra
    // CommonJS. O Jest roda em modo ESM (ver jest.config.cjs), então precisa
    // receber ESM de verdade pra conseguir interoperar com pacotes do
    // node_modules que só existem como ESM (ex.: o compilador de queries WASM
    // do Prisma 7, que usa import.meta.url e export{} nativos).
    ["@babel/preset-env", { targets: { node: "current" }, modules: false }],
    "@babel/preset-typescript",
  ],
};
