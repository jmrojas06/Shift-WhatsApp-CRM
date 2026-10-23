import { describe, expect, it, vi } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

// ============================================================
// Lista de conversaciones: filtros visibles como chips.
// Render estático: los efectos (consultas a Supabase) no corren.
// ============================================================

vi.mock("@/lib/supabase/client", () => ({
  createClient: () => {
    throw new Error("no se debe consultar la base en un render estático");
  },
}));

// Las claves se devuelven tal cual para afirmar qué copy se eligió.
vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
  useFormatter: () => ({ relativeTime: () => "hace 5 min" }),
  useNow: () => new Date("2026-10-22T12:00:00Z"),
}));

import { ConversationList } from "./conversation-list";
import type { Conversation } from "@/types";

function conv(id: string, unread: number): Conversation {
  return {
    id,
    status: "open",
    unread_count: unread,
    last_message_text: "Hola",
    last_message_at: "2026-10-22T11:55:00Z",
  } as Conversation;
}

function render(conversations: Conversation[]): string {
  return renderToStaticMarkup(
    React.createElement(ConversationList, {
      activeConversationId: null,
      onSelect: () => {},
      conversations,
      onConversationsLoaded: () => {},
    }),
  );
}

describe("<ConversationList /> filtros", () => {
  it("muestra los cinco filtros como botones, con 'Todas' activo", () => {
    const html = render([]);
    for (const key of [
      "filterAll",
      "filterUnread",
      "filterOpen",
      "filterPending",
      "filterClosed",
    ]) {
      expect(html).toContain(key);
    }
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(1);
    expect(html).toMatch(/aria-pressed="true"[^>]*>filterAll/);
  });

  it("pone el número de conversaciones sin leer en 'Sin leer'", () => {
    const html = render([conv("a", 2), conv("b", 0), conv("c", 1)]);
    expect(html).toMatch(/filterUnread<span[^>]*>2<\/span>/);
  });

  it("sin conversaciones sin leer no muestra contador", () => {
    const html = render([conv("a", 0)]);
    expect(html).toMatch(/filterUnread<\/button>/);
  });

  it("el buscador tiene etiqueta (no solo placeholder)", () => {
    const html = render([]);
    expect(html).toContain('for="inbox-search"');
    expect(html).toContain("searchLabel");
  });
});
