/**
 * Starter flow templates.
 *
 * Pre-canned flows users can clone with one click instead of building
 * from scratch. Each template is a plain JS object describing the same
 * shape `/api/flows` PUT accepts — name, trigger config, entry_node_id,
 * fallback_policy, nodes[] — keyed by a stable `slug`.
 *
 * The clone path (`/api/flows` POST with `template_slug`) creates a
 * NEW flow_row + flow_nodes rows for the user. `node_key`s are kept
 * verbatim (they're stable strings, not UUIDs, so cloning never
 * needs to rewrite edge references).
 *
 * A template that uses tags or a pipeline can't be plain JSON, because
 * those ids differ per account. It declares an `install` instead: what
 * to create in the account, and how to build the nodes from the ids.
 *
 * Choosing a single static module over a DB-backed gallery for v1
 * because: (a) the set is small and changes with code releases, not
 * data; (b) keeps templates portable across self-hosted instances
 * without migrations; (c) editing in source is the lowest-friction
 * way to add the next template.
 */

import type {
  CollectInputNodeConfig,
  ConditionNodeConfig,
  HandoffNodeConfig,
  KeywordTriggerConfig,
  SendButtonsNodeConfig,
  SendListNodeConfig,
  SendMediaNodeConfig,
  SendMessageNodeConfig,
  SetTagNodeConfig,
  StartNodeConfig,
} from "./types";
import {
  realEstateQualifiedTemplate,
  type AutomationTemplateDefinition,
} from "@/lib/automations/templates";
import { getT } from "@/lib/i18n/translate";
import type { TemplateResources, TemplateSetup } from "@/lib/templates/account-setup";

export type FlowTemplateNodeType =
  | "start"
  | "send_message"
  | "send_buttons"
  | "send_list"
  | "send_media"
  | "collect_input"
  | "condition"
  | "set_tag"
  | "handoff"
  | "end";

export interface FlowTemplateNode {
  node_key: string;
  node_type: FlowTemplateNodeType;
  config:
    | StartNodeConfig
    | SendMessageNodeConfig
    | SendButtonsNodeConfig
    | SendListNodeConfig
    | SendMediaNodeConfig
    | CollectInputNodeConfig
    | ConditionNodeConfig
    | SetTagNodeConfig
    | HandoffNodeConfig
    | Record<string, unknown>;
}

export interface FlowTemplateInstall {
  /** Created in the account before the flow is cloned. Admin only. */
  setup: TemplateSetup;
  /**
   * The nodes wired to this account's ids, plus the `tag_added`
   * automation that goes with them. `baseUrl` is the app's public URL,
   * which Meta needs to fetch the sample images in `public/`.
   */
  build(
    resources: TemplateResources,
    baseUrl: string,
  ): { nodes: FlowTemplateNode[]; automation: AutomationTemplateDefinition };
}

export interface FlowTemplate {
  slug: string;
  name: string;
  description: string;
  /** Used by the gallery to surface a relevant icon. lucide-react name. */
  icon: "MessageSquare" | "HelpCircle" | "UserPlus" | "Building2";
  trigger_type: "keyword" | "first_inbound_message" | "manual";
  trigger_config: KeywordTriggerConfig | Record<string, unknown>;
  entry_node_id: string;
  /** With `install`, a preview for the gallery; never clone these as is. */
  nodes: FlowTemplateNode[];
  install?: FlowTemplateInstall;
}

const t = getT("StarterFlows");

/** Comma-separated keyword list from the catalogue → trimmed array. */
function keywords(key: string): string[] {
  return t(key)
    .split(",")
    .map((k) => k.trim())
    .filter(Boolean);
}

// ============================================================
// 1. Welcome menu — the example from the owner's brief
// ============================================================
const WELCOME_MENU: FlowTemplate = {
  slug: "welcome_menu",
  name: t("welcome_menu.name"),
  description: t("welcome_menu.description"),
  icon: "MessageSquare",
  trigger_type: "keyword",
  trigger_config: { keywords: keywords("welcome_menu.keywords"), match_type: "contains" },
  entry_node_id: "start",
  nodes: [
    {
      node_key: "start",
      node_type: "start",
      config: { next_node_key: "welcome" },
    },
    {
      node_key: "welcome",
      node_type: "send_buttons",
      config: {
        text: t("welcome_menu.text"),
        footer_text: t("welcome_menu.footer"),
        buttons: [
          {
            reply_id: "existing",
            title: t("welcome_menu.existingButton"),
            next_node_key: "existing_handoff",
          },
          {
            reply_id: "new",
            title: t("welcome_menu.newButton"),
            next_node_key: "new_handoff",
          },
        ],
      } as SendButtonsNodeConfig,
    },
    {
      node_key: "existing_handoff",
      node_type: "handoff",
      config: {
        note: t("welcome_menu.existingNote"),
      } as HandoffNodeConfig,
    },
    {
      node_key: "new_handoff",
      node_type: "handoff",
      config: {
        note: t("welcome_menu.newNote"),
      } as HandoffNodeConfig,
    },
  ],
};

// ============================================================
// 2. FAQ bot — list-message answers, fully automated
// ============================================================
const FAQ_BOT: FlowTemplate = {
  slug: "faq_bot",
  name: t("faq_bot.name"),
  description: t("faq_bot.description"),
  icon: "HelpCircle",
  trigger_type: "keyword",
  trigger_config: {
    keywords: keywords("faq_bot.keywords"),
    match_type: "contains",
  },
  entry_node_id: "start",
  nodes: [
    {
      node_key: "start",
      node_type: "start",
      config: { next_node_key: "topics" },
    },
    {
      node_key: "topics",
      node_type: "send_list",
      config: {
        text: t("faq_bot.text"),
        button_label: t("faq_bot.buttonLabel"),
        sections: [
          {
            title: t("faq_bot.commonSection"),
            rows: [
              {
                reply_id: "hours",
                title: t("faq_bot.hoursRow"),
                next_node_key: "answer_hours",
              },
              {
                reply_id: "pricing",
                title: t("faq_bot.pricingRow"),
                next_node_key: "answer_pricing",
              },
              {
                reply_id: "refunds",
                title: t("faq_bot.refundsRow"),
                next_node_key: "answer_refunds",
              },
            ],
          },
          {
            title: t("faq_bot.otherSection"),
            rows: [
              {
                reply_id: "human",
                title: t("faq_bot.humanRow"),
                next_node_key: "human_handoff",
              },
            ],
          },
        ],
      } as SendListNodeConfig,
    },
    {
      node_key: "answer_hours",
      node_type: "send_message",
      config: {
        text: t("faq_bot.hoursAnswer"),
        next_node_key: "end",
      } as SendMessageNodeConfig,
    },
    {
      node_key: "answer_pricing",
      node_type: "send_message",
      config: {
        text: t("faq_bot.pricingAnswer"),
        next_node_key: "end",
      } as SendMessageNodeConfig,
    },
    {
      node_key: "answer_refunds",
      node_type: "send_message",
      config: {
        text: t("faq_bot.refundsAnswer"),
        next_node_key: "end",
      } as SendMessageNodeConfig,
    },
    {
      node_key: "human_handoff",
      node_type: "handoff",
      config: {
        note: t("faq_bot.humanNote"),
      } as HandoffNodeConfig,
    },
    {
      node_key: "end",
      node_type: "end",
      config: {},
    },
  ],
};

// ============================================================
// 3. Lead capture — collect_input chain, ends in a handoff
// ============================================================
const LEAD_CAPTURE: FlowTemplate = {
  slug: "lead_capture",
  name: t("lead_capture.name"),
  description: t("lead_capture.description"),
  icon: "UserPlus",
  trigger_type: "first_inbound_message",
  trigger_config: {},
  entry_node_id: "start",
  nodes: [
    {
      node_key: "start",
      node_type: "start",
      config: { next_node_key: "intro" },
    },
    {
      node_key: "intro",
      node_type: "send_message",
      config: {
        text: t("lead_capture.intro"),
        next_node_key: "ask_name",
      } as SendMessageNodeConfig,
    },
    {
      node_key: "ask_name",
      node_type: "collect_input",
      config: {
        prompt_text: t("lead_capture.askName"),
        var_key: "name",
        next_node_key: "ask_email",
      } as CollectInputNodeConfig,
    },
    {
      node_key: "ask_email",
      node_type: "collect_input",
      config: {
        prompt_text: t("lead_capture.askEmail", { name: "{{vars.name}}" }),
        var_key: "email",
        next_node_key: "ask_company",
      } as CollectInputNodeConfig,
    },
    {
      node_key: "ask_company",
      node_type: "collect_input",
      config: {
        prompt_text: t("lead_capture.askCompany"),
        var_key: "company",
        next_node_key: "handoff",
      } as CollectInputNodeConfig,
    },
    {
      node_key: "handoff",
      node_type: "handoff",
      config: {
        note: t("lead_capture.handoffNote", {
          name: "{{vars.name}}",
          email: "{{vars.email}}",
          company: "{{vars.company}}",
        }),
      } as HandoffNodeConfig,
    },
  ],
};

// ============================================================
// 4. Real estate — qualify, show a listing, hand off to an agent
// ============================================================

const REAL_ESTATE_SAMPLE_PHOTO = "/templates/real-estate/sample-floor-plan.png";

const REAL_ESTATE_ZONES = ["chapinero", "usaquen", "cedritos", "teusaquillo"];

const REAL_ESTATE_SETUP: TemplateSetup = {
  tags: {
    buy: { name: t("real_estate.tags.buy"), color: "#3b82f6" },
    rent: { name: t("real_estate.tags.rent"), color: "#8b5cf6" },
    qualified: { name: t("real_estate.tags.qualified"), color: "#22c55e" },
    ...Object.fromEntries(
      REAL_ESTATE_ZONES.map((zone) => [
        zone,
        { name: t(`real_estate.zones.${zone}`).toLowerCase(), color: "#f97316" },
      ]),
    ),
  },
  pipeline: {
    name: t("real_estate.pipeline"),
    stages: [
      { name: t("real_estate.stages.newLead"), color: "#3b82f6" },
      { name: t("real_estate.stages.contacted"), color: "#06b6d4" },
      { name: t("real_estate.stages.qualified"), color: "#eab308" },
      { name: t("real_estate.stages.visitScheduled"), color: "#f97316" },
      { name: t("real_estate.stages.negotiation"), color: "#8b5cf6" },
      { name: t("real_estate.stages.won"), color: "#22c55e" },
      { name: t("real_estate.stages.lost"), color: "#ef4444" },
    ],
  },
};

/**
 * The conversation from the demo video, for renters. Buyers get their
 * own budget list and listings, since rent figures make no sense to them.
 *
 * There's no property catalogue behind this: every customer on a branch
 * sees the same two sample listings, whatever area and budget they
 * picked, until the owner replaces them.
 */
function realEstateNodes(
  tagIds: TemplateResources["tagIds"],
  photoUrl: string,
): FlowTemplateNode[] {
  const setTag = (
    node_key: string,
    tag: string,
    next_node_key: string,
  ): FlowTemplateNode => ({
    node_key,
    node_type: "set_tag",
    config: {
      mode: "add",
      tag_id: tagIds[tag],
      next_node_key,
    } as SetTagNodeConfig,
  });

  const budgetList = (
    node_key: string,
    branch: "rent" | "buy",
    next_node_key: string,
  ): FlowTemplateNode => ({
    node_key,
    node_type: "send_list",
    config: {
      text: t(`real_estate.${branch}BudgetText`),
      button_label: t("real_estate.budgetLabel"),
      sections: [
        {
          rows: [1, 2, 3, 4].map((n) => ({
            reply_id: `${branch}_${n}`,
            title: t(`real_estate.${branch}Budgets.range${n}`),
            next_node_key,
          })),
        },
      ],
    } as SendListNodeConfig,
  });

  const listing = (
    node_key: string,
    caption: string,
    next_node_key: string,
  ): FlowTemplateNode => ({
    node_key,
    node_type: "send_media",
    config: {
      media_type: "image",
      media_url: photoUrl,
      caption,
      next_node_key,
    } as SendMediaNodeConfig,
  });

  const visitButton = {
    reply_id: "visit",
    title: t("real_estate.visitButton"),
    next_node_key: "tag_qualified_visit",
  };
  const agentButton = {
    reply_id: "agent",
    title: t("real_estate.agentButton"),
    next_node_key: "tag_qualified_agent",
  };
  const listingActions = (
    node_key: string,
    nextListing: string,
  ): FlowTemplateNode => ({
    node_key,
    node_type: "send_buttons",
    config: {
      text: t("real_estate.actionsText"),
      buttons: [
        visitButton,
        {
          reply_id: "other",
          title: t("real_estate.otherButton"),
          next_node_key: nextListing,
        },
        agentButton,
      ],
    } as SendButtonsNodeConfig,
  });

  return [
    {
      node_key: "start",
      node_type: "start",
      config: { next_node_key: "greeting" },
    },
    {
      node_key: "greeting",
      node_type: "send_buttons",
      config: {
        text: t("real_estate.greeting"),
        buttons: [
          {
            reply_id: "buy",
            title: t("real_estate.buyButton"),
            next_node_key: "tag_buy",
          },
          {
            reply_id: "rent",
            title: t("real_estate.rentButton"),
            next_node_key: "tag_rent",
          },
          // Hasn't answered anything yet, so not qualified: this one
          // reaches the inbox with no deal and no agent assigned.
          { ...agentButton, next_node_key: "agent_message" },
        ],
      } as SendButtonsNodeConfig,
    },
    setTag("tag_buy", "buy", "zones"),
    setTag("tag_rent", "rent", "zones"),
    {
      node_key: "zones",
      node_type: "send_list",
      config: {
        text: t("real_estate.zonesText"),
        button_label: t("real_estate.zonesLabel"),
        sections: [
          {
            rows: [
              ...REAL_ESTATE_ZONES.map((zone) => ({
                reply_id: zone,
                title: t(`real_estate.zones.${zone}`),
                next_node_key: `tag_${zone}`,
              })),
              {
                reply_id: "other_zone",
                title: t("real_estate.zones.other"),
                next_node_key: "is_buying",
              },
            ],
          },
        ],
      } as SendListNodeConfig,
    },
    ...REAL_ESTATE_ZONES.map((zone) => setTag(`tag_${zone}`, zone, "is_buying")),
    {
      node_key: "is_buying",
      node_type: "condition",
      config: {
        subject: "tag",
        subject_key: tagIds.buy,
        operator: "present",
        true_next: "budget_buy",
        false_next: "budget_rent",
      } as ConditionNodeConfig,
    },
    budgetList("budget_rent", "rent", "listing_rent"),
    budgetList("budget_buy", "buy", "listing_buy"),
    listing("listing_rent", t("real_estate.rentListing"), "actions_rent"),
    listing("listing_buy", t("real_estate.buyListing"), "actions_buy"),
    listingActions("actions_rent", "listing_rent_2"),
    listingActions("actions_buy", "listing_buy_2"),
    listing("listing_rent_2", t("real_estate.rentListing2"), "actions_last"),
    listing("listing_buy_2", t("real_estate.buyListing2"), "actions_last"),
    {
      node_key: "actions_last",
      node_type: "send_buttons",
      config: {
        text: t("real_estate.actionsText"),
        buttons: [visitButton, agentButton],
      } as SendButtonsNodeConfig,
    },
    // Tagging is what fires the automation, which creates the deal and
    // assigns the agent, so it has to happen before the handoff.
    setTag("tag_qualified_visit", "qualified", "visit_message"),
    {
      node_key: "visit_message",
      node_type: "send_message",
      config: {
        text: t("real_estate.visitMessage"),
        next_node_key: "visit_handoff",
      } as SendMessageNodeConfig,
    },
    {
      node_key: "visit_handoff",
      node_type: "handoff",
      config: { note: t("real_estate.visitNote") } as HandoffNodeConfig,
    },
    setTag("tag_qualified_agent", "qualified", "agent_message"),
    {
      node_key: "agent_message",
      node_type: "send_message",
      config: {
        text: t("real_estate.agentMessage"),
        next_node_key: "agent_handoff",
      } as SendMessageNodeConfig,
    },
    {
      node_key: "agent_handoff",
      node_type: "handoff",
      config: { note: t("real_estate.agentNote") } as HandoffNodeConfig,
    },
  ];
}

const REAL_ESTATE: FlowTemplate = {
  slug: "real_estate",
  name: t("real_estate.name"),
  description: t("real_estate.description"),
  icon: "Building2",
  trigger_type: "first_inbound_message",
  trigger_config: {},
  entry_node_id: "start",
  nodes: realEstateNodes({}, ""),
  install: {
    setup: REAL_ESTATE_SETUP,
    build: ({ tagIds, pipelineId, stageIdByName }, baseUrl) => ({
      nodes: realEstateNodes(tagIds, `${baseUrl}${REAL_ESTATE_SAMPLE_PHOTO}`),
      automation: realEstateQualifiedTemplate({
        tagId: tagIds.qualified,
        pipelineId,
        stageId: stageIdByName[t("real_estate.stages.qualified")],
      }),
    }),
  },
};

// ============================================================
// Registry
// ============================================================

const TEMPLATES: Record<string, FlowTemplate> = {
  welcome_menu: WELCOME_MENU,
  faq_bot: FAQ_BOT,
  lead_capture: LEAD_CAPTURE,
  real_estate: REAL_ESTATE,
};

export function getFlowTemplate(slug: string): FlowTemplate | null {
  return TEMPLATES[slug] ?? null;
}

export function listFlowTemplates(): FlowTemplate[] {
  return Object.values(TEMPLATES);
}
