import { cn } from "@/lib/utils";

/** "Barbería Élite" → "BÉ"; one word → its first two letters. */
export function workspaceInitials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "";
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
}

/** Square monogram for the business the user is working in. */
export function WorkspaceBadge({
  name,
  className,
}: {
  name: string;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/12 font-heading text-[13px] font-bold text-primary",
        className,
      )}
    >
      {workspaceInitials(name)}
    </span>
  );
}
