"use client";

import Link from "next/link";
import {
  ChevronDown,
  Columns3,
  Megaphone,
  Plus,
  UserPlus,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { useTranslations } from "next-intl";

import { useCan } from "@/hooks/use-can";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

interface CreateAction {
  labelKey: string;
  href: string;
  icon: LucideIcon;
}

// Each entry lands on the page that owns the create flow; contacts and
// pipelines read `?new=1` and open their own form on arrival.
const ACTIONS: CreateAction[] = [
  { labelKey: "createContact", href: "/contacts?new=1", icon: UserPlus },
  { labelKey: "createDeal", href: "/pipelines?new=1", icon: Columns3 },
  { labelKey: "createBroadcast", href: "/broadcasts/new", icon: Megaphone },
  { labelKey: "createAutomation", href: "/automations/new", icon: Zap },
];

/**
 * "Crear" — one entry point for the four create flows, available from
 * every page. Icon-only on phones. Hidden for read-only roles (the
 * target pages would refuse the action anyway).
 */
export function CreateMenu() {
  const t = useTranslations("Header");
  const canCreate = useCan("send-messages");
  if (!canCreate) return null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={t("create")}
        className="inline-flex size-11 items-center justify-center gap-1.5 rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none data-popup-open:bg-muted sm:h-9 sm:w-auto sm:border sm:border-input sm:bg-card sm:px-3 sm:text-sm sm:font-medium sm:text-foreground sm:shadow-(--shadow-card)"
      >
        <Plus className="size-5 sm:size-4" />
        <span className="hidden sm:inline">{t("create")}</span>
        <ChevronDown className="hidden size-3.5 text-muted-foreground sm:inline" />
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        sideOffset={6}
        className="min-w-52 bg-popover text-popover-foreground ring-border"
      >
        {ACTIONS.map((action) => (
          <DropdownMenuItem
            key={action.href}
            className="min-h-10 pointer-coarse:min-h-11"
            render={
              <Link
                href={action.href}
                className="text-popover-foreground focus:bg-accent focus:text-accent-foreground"
              />
            }
          >
            <action.icon className="size-4 text-muted-foreground" />
            {t(action.labelKey)}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
