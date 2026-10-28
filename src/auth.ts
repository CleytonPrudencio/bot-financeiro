import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import type { NextFunction, Request, Response } from 'express';
import { config } from './config.js';
import { query, umOuNada } from './db.js';

// Sessão do painel: JWT num cookie httpOnly, SameSite=Strict, que vale 12 horas.
// Contra CSRF, além do SameSite, toda chamada que muda algo precisa do cabeçalho
// "X-Painel: 1" — um formulário de outro site não consegue mandar cabeçalho próprio.

const COOKIE = 'sessao';
const DURACAO_S = 12 * 60 * 60;
// hash de uma senha qualquer, para comparar quando o e-mail não existe
const HASH_FALSO = bcrypt.hashSync('nao-existe', 12);

declare module 'express-serve-static-core' {
  interface Request {
    usuarioId?: number;
  }
}

export async function entrar(email: string, senha: string): Promise<{ id: number; email: string } | null> {
  const u = await umOuNada<{ id: number; email: string; senha_hash: string }>(
    'select id, email, senha_hash from usuarios where lower(email) = lower($1)',
    [email],
  );
  // compara mesmo sem usuário, para o tempo de resposta não dizer se o e-mail existe
  const ok = await bcrypt.compare(senha, u?.senha_hash ?? HASH_FALSO);
  if (!u || !ok) return null;
  await query('update usuarios set ultimo_login = now() where id = $1', [u.id]);
  return { id: u.id, email: u.email };
}

export function gravarSessao(res: Response, usuarioId: number): void {
  const token = jwt.sign({ sub: String(usuarioId) }, config.segredoSessao, { expiresIn: DURACAO_S });
  res.cookie(COOKIE, token, {
    httpOnly: true,
    secure: config.producao,
    sameSite: 'strict',
    maxAge: DURACAO_S * 1000,
    path: '/',
  });
}

export function apagarSessao(res: Response): void {
  res.clearCookie(COOKIE, { path: '/' });
}

export function exigeLogin(req: Request, res: Response, next: NextFunction): void {
  const token = req.cookies?.[COOKIE] as string | undefined;
  try {
    if (!token) throw new Error('sem sessão');
    const dados = jwt.verify(token, config.segredoSessao) as { sub: string };
    req.usuarioId = Number(dados.sub);
    next();
  } catch {
    res.status(401).json({ erro: 'faça login' });
  }
}

export function exigeCabecalhoPainel(req: Request, res: Response, next: NextFunction): void {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method) || req.get('x-painel') === '1') return next();
  res.status(403).json({ erro: 'pedido sem o cabeçalho do painel' });
}

export async function hashSenha(senha: string): Promise<string> {
  return bcrypt.hash(senha, 12);
}
