// Cria um usuário do painel, ou troca a senha de um que já existe. A senha é gerada aqui e
// aparece UMA vez na tela: guarde no gerenciador de senhas.
//
//   na VM:   docker exec -it bot-app node dist/scripts/criar-admin.js voce@exemplo.com
//   local:   npm run admin -- voce@exemplo.com

import { hashSenha } from '../auth.js';
import { senhaAleatoria } from '../crypto.js';
import { migrar, pool, query } from '../db.js';

const email = process.argv[2]?.trim().toLowerCase();
if (!email || !email.includes('@')) {
  console.error('uso: criar-admin <email>');
  process.exit(1);
}

await migrar();
const senha = senhaAleatoria();
const hash = await hashSenha(senha);
const r = await query<{ novo: boolean }>(
  `insert into usuarios (email, senha_hash) values ($1, $2)
   on conflict (email) do update set senha_hash = excluded.senha_hash
   returning (xmax = 0) as novo`,
  [email, hash],
);
await query('insert into eventos (tipo, detalhe) values ($1, $2)', [
  r[0]?.novo ? 'usuario_criado' : 'senha_trocada',
  JSON.stringify({ email, por: 'criar-admin' }),
]);
console.log(`${r[0]?.novo ? 'usuário criado' : 'senha trocada'}: ${email}`);
console.log(`senha: ${senha}`);
await pool.end();
