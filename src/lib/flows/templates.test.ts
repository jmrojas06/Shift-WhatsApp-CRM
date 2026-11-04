import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AUTOMATION_TEMPLATES } from "@/lib/automations/templates";
import {
  validateStepsForActivation,
  validateTriggerForActivation,
} from "@/lib/automations/validate";
import {
  getFlowTemplate,
  listFlowTemplates,
  type FlowTemplateNode,
} from "./templates";
import { validateFlowForActivation } from "./validate";

/** What the install leaves in an account, with fake ids. */
function install(flowTemplate: NonNullable<ReturnType<typeof getFlowTemplate>>) {
  const { setup, build } = flowTemplate.install!;
  const resources = {
    tagIds: Object.fromEntries(Object.keys(setup.tags).map((key) => [key, `tag-${key}`])),
    pipelineId: "pipeline-1",
    stageIdByName: Object.fromEntries(
      setup.pipeline.stages.map((stage, index) => [stage.name, `stage-${index}`]),
    ),
  };
  return { setup, resources, ...build(resources, "https://crm.example") };
}

const flowInput = (flowTemplate: NonNullable<ReturnType<typeof getFlowTemplate>>) => ({
  name: flowTemplate.name,
  trigger_type: flowTemplate.trigger_type,
  trigger_config: flowTemplate.trigger_config as Record<string, unknown>,
  entry_node_id: flowTemplate.entry_node_id,
});

const nodeInputs = (nodes: FlowTemplateNode[]) =>
  nodes.map((node) => ({ ...node, config: node.config as Record<string, unknown> }));

const template = getFlowTemplate("real_estate")!;
const { setup, resources, nodes, automation } = install(template);

type Config = Record<string, never>;

/** Replays a conversation: `replies` are the reply_ids the customer taps. */
function play(replies: string[]): FlowTemplateNode[] {
  const byKey = new Map(nodes.map((node) => [node.node_key, node]));
  const pending = [...replies];
  const tags = new Set<string>();
  const visited: FlowTemplateNode[] = [];

  let key: string | undefined = template.entry_node_id;
  while (key) {
    const node: FlowTemplateNode = byKey.get(key)!;
    visited.push(node);
    const config = node.config as Config;
    if (node.node_type === "handoff" || node.node_type === "end") return visited;
    if (node.node_type === "set_tag") tags.add(config.tag_id);
    if (node.node_type === "condition") {
      key = tags.has(config.subject_key) ? config.true_next : config.false_next;
      continue;
    }
    if (node.node_type === "send_buttons" || node.node_type === "send_list") {
      const options: { reply_id: string; next_node_key: string }[] =
        node.node_type === "send_buttons"
          ? config.buttons
          : (config.sections as unknown as { rows: never[] }[]).flatMap((s) => s.rows);
      const reply = pending.shift();
      const option = options.find((candidate) => candidate.reply_id === reply);
      if (!option) throw new Error(`"${node.node_key}" has no option "${reply}"`);
      key = option.next_node_key;
      continue;
    }
    key = config.next_node_key;
  }
  return visited;
}

const appliedTags = (visited: FlowTemplateNode[]): string[] =>
  visited
    .filter((node) => node.node_type === "set_tag")
    .map((node) => (node.config as Config).tag_id);

describe("real_estate flow template", () => {
  it("is offered in the new-flow gallery", () => {
    expect(listFlowTemplates().map((t) => t.slug)).toContain("real_estate");
  });

  it("passes activation validation with no errors or warnings once installed", () => {
    expect(validateFlowForActivation(flowInput(template), nodeInputs(nodes))).toEqual([]);
  });

  it("answers every first message, whatever the customer writes", () => {
    expect(template.trigger_type).toBe("first_inbound_message");
  });

  it("plays the demo: rent, area, budget, listing, visit, handoff", () => {
    const visited = play(["rent", "chapinero", "rent_2", "visit"]);

    expect(visited.map((node) => node.node_type)).toEqual([
      "start",
      "send_buttons",
      "set_tag",
      "send_list",
      "set_tag",
      "condition",
      "send_list",
      "send_media",
      "send_buttons",
      "set_tag",
      "send_message",
      "handoff",
    ]);
    expect(appliedTags(visited)).toEqual([
      "tag-rent",
      "tag-chapinero",
      "tag-qualified",
    ]);
  });

  it("asks buyers for a purchase budget and shows them a listing for sale", () => {
    const rent = play(["rent", "chapinero", "rent_2", "visit"]);
    const buy = play(["buy", "chapinero", "buy_2", "visit"]);

    const lists = (visited: FlowTemplateNode[]) =>
      visited.filter((node) => node.node_type === "send_list").map((n) => n.node_key);
    const listings = (visited: FlowTemplateNode[]) =>
      visited.filter((node) => node.node_type === "send_media").map((n) => n.node_key);

    expect(lists(buy)[1]).not.toBe(lists(rent)[1]);
    expect(listings(buy)[0]).not.toBe(listings(rent)[0]);
    expect(appliedTags(buy)).toEqual(["tag-buy", "tag-chapinero", "tag-qualified"]);
  });

  it("shows a different listing on 'see another', without looping forever", () => {
    const visited = play(["rent", "cedritos", "rent_1", "other", "visit"]);

    const listings = visited.filter((node) => node.node_type === "send_media");
    expect(listings).toHaveLength(2);
    expect(listings[0].config).not.toEqual(listings[1].config);
    expect(() => play(["rent", "cedritos", "rent_1", "other", "other"])).toThrow(
      /has no option "other"/,
    );
  });

  it("does not tag an area when the customer picks 'other area'", () => {
    expect(appliedTags(play(["rent", "other_zone", "rent_1", "visit"]))).toEqual([
      "tag-rent",
      "tag-qualified",
    ]);
  });

  it("hands off without qualifying when the customer asks for an agent up front", () => {
    const visited = play(["agent"]);

    expect(visited.at(-1)?.node_type).toBe("handoff");
    expect(visited.at(-2)?.node_type).toBe("send_message");
    expect(appliedTags(visited)).toEqual([]);
  });

  it("qualifies whoever finished the questions and then asks for an agent", () => {
    const visited = play(["buy", "usaquen", "buy_3", "agent"]);

    expect(appliedTags(visited)).toContain("tag-qualified");
    expect(visited.at(-1)?.node_type).toBe("handoff");
  });

  it("points every listing at an absolute URL of an image that ships with the app", () => {
    const photos = nodes
      .filter((node) => node.node_type === "send_media")
      .map((node) => (node.config as Config).media_url as string);

    expect(photos).toHaveLength(4);
    for (const photo of photos) {
      const url = new URL(photo);
      expect(url.origin).toBe("https://crm.example");
      expect(existsSync(join(process.cwd(), "public", url.pathname))).toBe(true);
    }
  });
});

describe("real_estate automation template", () => {
  it("passes activation validation once installed", () => {
    expect(
      validateTriggerForActivation(automation.trigger_type, automation.trigger_config),
    ).toEqual([]);
    expect(
      validateStepsForActivation(
        automation.steps as unknown as Parameters<typeof validateStepsForActivation>[0],
      ),
    ).toEqual([]);
  });

  it("creates the deal in the Qualified stage and assigns by turns on the qualified tag", () => {
    const qualifiedStage = setup.pipeline.stages[2].name;

    expect(automation.trigger_type).toBe("tag_added");
    expect(automation.trigger_config).toEqual({ tag_id: "tag-qualified" });
    expect(automation.steps.map((step) => step.step_type)).toEqual([
      "create_deal",
      "assign_conversation",
    ]);
    expect(automation.steps[0].step_config).toMatchObject({
      pipeline_id: "pipeline-1",
      stage_id: resources.stageIdByName[qualifiedStage],
    });
    expect(automation.steps[1].step_config).toEqual({ mode: "round_robin" });
  });

  it("leaves the account-specific ids blank in the gallery, for the builder to fill in", () => {
    const blank = AUTOMATION_TEMPLATES.real_estate_qualified;

    expect(blank.trigger_config).toEqual({ tag_id: "" });
    expect(blank.steps[0].step_config).toMatchObject({ pipeline_id: "", stage_id: "" });
  });
});

// The suite runs on the English catalogue and production on Spanish, and
// Meta's limits apply to the length of each translation.
describe.each(["es", "en", "pt", "ko"])("real_estate in %s", (locale) => {
  afterEach(() => {
    vi.doUnmock("@app-messages");
    vi.resetModules();
  });

  it("passes both validators", async () => {
    vi.resetModules();
    vi.doMock("@app-messages", () => ({
      default: JSON.parse(readFileSync(join(process.cwd(), `messages/${locale}.json`), "utf8")),
    }));
    const flows = await import("./templates");
    const automations = await import("@/lib/automations/validate");
    const { validateFlowForActivation: validateFlow } = await import("./validate");

    const translated = flows.getFlowTemplate("real_estate")!;
    const { nodes: translatedNodes, automation: translatedAutomation } = install(translated);

    expect(validateFlow(flowInput(translated), nodeInputs(translatedNodes))).toEqual([]);
    expect(
      automations.validateTriggerForActivation(
        translatedAutomation.trigger_type,
        translatedAutomation.trigger_config,
      ),
    ).toEqual([]);
    expect(
      automations.validateStepsForActivation(
        translatedAutomation.steps as unknown as Parameters<typeof validateStepsForActivation>[0],
      ),
    ).toEqual([]);
  });
});

describe("real_estate Spanish copy", () => {
  const es = JSON.parse(
    readFileSync(join(process.cwd(), "messages/es.json"), "utf8"),
  ) as { StarterFlows: { real_estate: Record<string, never> } };
  const copy = es.StarterFlows.real_estate;

  it("sets up the seven funnel stages, in order", () => {
    expect(Object.values(copy.stages)).toEqual([
      "Lead nuevo",
      "Contactado",
      "Calificado",
      "Visita agendada",
      "Negociación",
      "Cerrado ganado",
      "Cerrado perdido",
    ]);
  });

  it("matches the conversation in the demo video", () => {
    expect(copy.buyButton).toBe("Comprar");
    expect(copy.rentButton).toBe("Arrendar");
    expect(copy.agentButton).toBe("Hablar con asesor");
    expect(copy.zonesText).toBe("¿En qué zona te gustaría vivir?");
    expect(copy.zonesLabel).toBe("Ver zonas");
    expect(Object.values(copy.zones)).toEqual([
      "Chapinero",
      "Usaquén",
      "Cedritos",
      "Teusaquillo",
      "Otra zona",
    ]);
    expect(copy.rentBudgetText).toBe("¿Cuál es tu presupuesto mensual?");
    expect(copy.budgetLabel).toBe("Ver opciones");
    expect(Object.values(copy.rentBudgets)).toEqual([
      "Hasta $1.500.000",
      "$1.500.000 a $2.500.000",
      "$2.500.000 a $4.000.000",
      "Más de $4.000.000",
    ]);
    expect(copy.rentListing).toBe(
      "Mira este apartamento en Chapinero:\n\n2 habitaciones, 2 baños\n68 m², parqueadero\n$2.300.000 al mes",
    );
    expect(copy.actionsText).toBe("¿Qué quieres hacer?");
    expect(copy.visitButton).toBe("Quiero visitarlo");
    expect(copy.otherButton).toBe("Ver otro");
    expect(copy.visitMessage).toBe(
      "¡Perfecto! Te paso con un asesor para cuadrar la visita por este mismo chat. 🙌",
    );
  });

  it("does not greet real customers with the name of the fictional demo business", () => {
    expect(JSON.stringify(copy)).not.toContain("Raíces");
  });
});
