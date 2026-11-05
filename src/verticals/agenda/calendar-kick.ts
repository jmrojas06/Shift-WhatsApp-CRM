// ============================================================
// Aviso "hay citas por copiar a Google Calendar".
//
// Las rutas del panel lo llaman (con `after()`, ya respondida la
// petición) después de cada escritura que guardó: crear, mover,
// cancelar o cambiar el estado de una cita. Por ahora no hace nada:
// la tarea de sincronización (T10) llena el cuerpo.
//
// Contrato para quien lo llene: NUNCA debe lanzar ni tardar de más
// (corre en segundo plano) y solo recibe la cuenta; las citas que hay
// que copiar las marca el trigger `google_dirty` de la migración 056.
// ============================================================

export async function kickCalendarSync(accountId: string): Promise<void> {
  void accountId
}
