/**
 * La consulta pidió una columna que aún no existe: Postgres
 * `undefined_column` (42703) o el equivalente de PostgREST (PGRST204).
 *
 * Señal de "despliegue por delante de su migración" (047, 053…): quien la
 * reciba repite la lectura sin esa columna en vez de romper la app.
 * (No incluye tablas ausentes, 42P01: eso es otra migración.)
 */
export function isUndefinedColumnError(
  error: { code?: string | null; message?: string } | null | undefined,
): boolean {
  const code = error?.code
  return code === '42703' || code === 'PGRST204'
}
