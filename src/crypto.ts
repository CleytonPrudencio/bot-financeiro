import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

// Chaves de API das exchanges vão para o banco cifradas com AES-256-GCM. A chave de cifra vem de
// BOT_ENCRYPTION_KEY e nunca entra no banco: um dump do banco sozinho não abre as chaves.
// Formato guardado: "v1:" + base64(iv 12 bytes | tag 16 bytes | texto cifrado).

const PREFIXO = 'v1:';

export function derivarChave(segredo: string): Buffer {
  // sal fixo e público: o objetivo é só transformar uma frase de tamanho qualquer em 32 bytes
  return scryptSync(segredo, 'bot-financeiro:chaves-de-api', 32);
}

export function cifrar(texto: string, chave: Buffer): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', chave, iv);
  const cifrado = Buffer.concat([c.update(texto, 'utf8'), c.final()]);
  return PREFIXO + Buffer.concat([iv, c.getAuthTag(), cifrado]).toString('base64');
}

export function decifrar(guardado: string, chave: Buffer): string {
  if (!guardado.startsWith(PREFIXO)) throw new Error('valor cifrado em formato desconhecido');
  const bruto = Buffer.from(guardado.slice(PREFIXO.length), 'base64');
  const iv = bruto.subarray(0, 12);
  const tag = bruto.subarray(12, 28);
  const d = createDecipheriv('aes-256-gcm', chave, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(bruto.subarray(28)), d.final()]).toString('utf8');
}

/** Token do webhook: 32 bytes aleatórios. Só o hash vai para o banco. */
export function novoToken(): { token: string; hash: string; prefixo: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: hashToken(token), prefixo: token.slice(0, 6) };
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** Compara dois hashes em tempo constante. */
export function iguaisSeguro(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Senha aleatória legível para o admin (mostrada uma única vez). */
export function senhaAleatoria(): string {
  return randomBytes(18).toString('base64url');
}
