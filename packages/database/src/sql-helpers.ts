import { sql, type SQL } from 'drizzle-orm';

const SQL_ARRAY_TYPES = { text: 'text', uuid: 'uuid', int: 'int', char64: 'char(64)' } as const;

/**
 * Array SQL parametrizado. O Drizzle expande arrays JS como lista de parâmetros "($1, $2)",
 * que o Postgres interpreta como record; por isso o array é montado explicitamente.
 * Lista vazia gera um array vazio tipado (ANY(...) resulta em falso).
 */
export function sqlArray(values: readonly (string | number)[], type: keyof typeof SQL_ARRAY_TYPES): SQL {
  const cast = sql.raw(SQL_ARRAY_TYPES[type]);
  if (values.length === 0) return sql`ARRAY[]::${cast}[]`;
  return sql`ARRAY[${sql.join(
    values.map((v) => sql`${v}`),
    sql`, `,
  )}]::${cast}[]`;
}
