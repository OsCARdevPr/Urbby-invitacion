import type { ZodError } from 'zod';

export const parseId = (value: string | undefined) => {
  const n = Number(value);
  return Number.isInteger(n) && n > 0 ? n : -1;
};

export const firstError = (error: ZodError) => error.issues[0]?.message ?? 'Datos no válidos';
