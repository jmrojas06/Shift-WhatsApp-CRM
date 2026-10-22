// Legacy URL kept for external crons (docs/despliegue-vercel.md). Remove
// once every cron points to /api/verticals/agenda/reminders/run.
//
// Route segment config is read statically by Next, so `maxDuration` is
// declared as a literal here instead of being re-exported.
export { GET } from '@/app/api/verticals/agenda/reminders/run/route'

export const maxDuration = 60
