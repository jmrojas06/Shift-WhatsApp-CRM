import {
  Bot,
  Columns3,
  LayoutDashboard,
  Megaphone,
  MessageSquare,
  Settings,
  Users,
  Workflow,
  Zap,
  type LucideIcon,
} from "lucide-react";

import {
  getModulesNav,
  type AccountModulesSource,
} from "@/lib/verticals/registry";
import { isRouteHidden, type ViewContext } from "@/lib/view-mode";

/**
 * Single source of truth for the app navigation, shared by the desktop
 * sidebar, the mobile drawer and the mobile bottom tab bar so the three
 * never drift. Labels are `Sidebar.<labelKey>` messages.
 */
export interface NavItem {
  href: string;
  labelKey: string;
  icon: LucideIcon;
  /** Renders a small "Beta" chip. Purely informational. */
  beta?: boolean;
  /** Shorter label for the mobile tab bar, when the full one is long. */
  mobileLabelKey?: string;
}

export interface NavGroup {
  /** `Sidebar.<labelKey>` heading shown above the group. */
  labelKey: string;
  items: NavItem[];
}

const DASHBOARD: NavItem = { href: "/dashboard", labelKey: "dashboard", icon: LayoutDashboard };
const INBOX: NavItem = {
  href: "/inbox",
  labelKey: "inbox",
  icon: MessageSquare,
  mobileLabelKey: "inboxShort",
};
const CONTACTS: NavItem = { href: "/contacts", labelKey: "contacts", icon: Users };
const PIPELINES: NavItem = { href: "/pipelines", labelKey: "pipelines", icon: Columns3 };

export const SETTINGS_ITEM: NavItem = {
  href: "/settings",
  labelKey: "settings",
  icon: Settings,
};

/**
 * Day-to-day work first (answer, book, sell), growth tools second.
 * Active modules (agenda, ventas…) slot in right after the inbox.
 */
export function getNavGroups(
  account: AccountModulesSource | null | undefined,
  view?: ViewContext,
): NavGroup[] {
  const groups: NavGroup[] = [
    {
      labelKey: "groupDaily",
      items: [DASHBOARD, INBOX, ...getModulesNav(account), CONTACTS],
    },
    {
      labelKey: "groupGrowth",
      items: [
        PIPELINES,
        { href: "/broadcasts", labelKey: "broadcasts", icon: Megaphone },
        { href: "/automations", labelKey: "automations", icon: Zap },
        { href: "/flows", labelKey: "flows", icon: Workflow, beta: true },
        { href: "/agents", labelKey: "aiAgents", icon: Bot },
      ],
    },
  ];
  if (!view) return groups;
  // Simple view (lib/view-mode): drop what Shift configures, and any
  // group left empty.
  return groups
    .map((group) => ({
      ...group,
      items: group.items.filter((item) => !isRouteHidden(item.href, view)),
    }))
    .filter((group) => group.items.length > 0);
}

/**
 * The four destinations of the mobile tab bar (the fifth slot is
 * "Más", which opens the full drawer). The third slot is the first
 * active module, or the pipeline board for accounts without one.
 */
export function getMobileTabs(
  account: AccountModulesSource | null | undefined,
): NavItem[] {
  const [firstModule] = getModulesNav(account);
  return [DASHBOARD, INBOX, firstModule ?? PIPELINES, CONTACTS];
}

/** Whether `href` is the active section for `pathname`. */
export function isNavActive(href: string, pathname: string): boolean {
  if (href === "/dashboard") return pathname === "/dashboard";
  return pathname === href || pathname.startsWith(`${href}/`);
}
