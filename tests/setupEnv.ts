// Roda antes de qualquer módulo do projeto ser importado (setupFiles no jest.config.cjs),
// que é o único momento em que dá pra mexer nisto: `storageEnabled` é uma const de
// módulo, calculada uma vez só no import de src/config/env.ts.
//
// Sem isto, a suíte herda o .env de quem está rodando. Numa máquina com S3_REGION e
// S3_BUCKET preenchidos (dev que configurou upload local), storageEnabled vira true e
// setStorageForTests(null) — cujo contrato é "restaura a implementação real, CONFORME
// storageEnabled" — devolve o adapter S3 de verdade em vez do desligado. O teste de
// degradação graciosa (D-18) então recebe 201 onde exige 503, e falha por causa do
// ambiente, não do código. No CI passava porque lá não existe .env nenhum.
//
// Vale também como trava da Regra 5 (nenhum teste automatizado abre conexão com a AWS):
// hoje o que impede a chamada de rede é o presigned POST ser assinatura local, não o
// desenho. Com o storage desligado por construção, headObject/readFirstBytes não têm como
// escapar pro S3 real. Quem precisa exercitar o caminho feliz injeta um fake com
// setStorageForTests(fakeStorage), que continua sobrepondo o port normalmente.
//
// String vazia, e não `delete`: o env.ts importa 'dotenv/config', e o dotenv preenche
// qualquer chave AUSENTE de process.env — apagar aqui só faria ele reinserir o valor do
// .env logo em seguida. Presente-porém-vazia ele preserva, e o optionalString() do
// schema converte '' em undefined.
process.env.S3_REGION = '';
process.env.S3_BUCKET = '';
