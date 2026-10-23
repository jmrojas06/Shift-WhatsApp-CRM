"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { Loader2 } from "lucide-react";

import { useTranslations } from "next-intl";

import { Button } from "@/components/ui/button";
import { FlowEditorShell } from "@/components/flows/flow-editor-shell";
import type { FlowRow, FlowNodeRow } from "@/lib/flows/types";

/**
 * Flow editor shell.
 *
 * Loads `{flow, nodes}` from `/api/flows/[id]` and hands it to
 * `<FlowBuilder>`. Owns the loading/error state so the builder can
 * focus purely on editing.
 *
 * Open to every authenticated user — the beta gate that previously
 * 404'd non-beta accounts was removed in PR #134. The API still
 * 404s on a flow id the caller doesn't own (RLS), which becomes the
 * "Flow not found" state below.
 */
export default function FlowEditorPage() {
  const params = useParams<{ id: string }>();
  const t = useTranslations("Flows.edit");

  const [flow, setFlow] = useState<FlowRow | null>(null);
  const [nodes, setNodes] = useState<FlowNodeRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  // A real load failure (network/500) is not "flow not found": say what
  // happened and let the person try again.
  const [loadFailed, setLoadFailed] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    if (!params.id) return;
    let cancelled = false;
    (async () => {
      setLoadFailed(false);
      try {
        const res = await fetch(`/api/flows/${params.id}`);
        if (res.status === 404) {
          if (!cancelled) setNotFound(true);
          return;
        }
        if (!res.ok) throw new Error(`Failed: ${res.status}`);
        const json = (await res.json()) as {
          flow: FlowRow;
          nodes: FlowNodeRow[];
        };
        if (!cancelled) {
          setFlow(json.flow);
          setNodes(json.nodes ?? []);
        }
      } catch (err) {
        if (!cancelled) {
          console.error(err);
          setLoadFailed(true);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [params.id, reloadKey]);

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center" role="status">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" aria-hidden />
        <span className="sr-only">{t("loading")}</span>
      </div>
    );
  }
  if (loadFailed) {
    return (
      <div className="flex h-64 flex-col items-center justify-center gap-3 text-center">
        <p role="alert" className="max-w-sm text-sm text-destructive">
          {t("loadError")}
        </p>
        <Button
          variant="outline"
          onClick={() => {
            setLoading(true);
            setReloadKey((k) => k + 1);
          }}
        >
          {t("retry")}
        </Button>
        <Link
          href="/flows"
          className="inline-flex min-h-11 items-center rounded-lg px-3 text-sm text-primary outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          {t("backToFlows")}
        </Link>
      </div>
    );
  }
  if (notFound || !flow) {
    return (
      <div className="flex h-64 flex-col items-center justify-center gap-3">
        <p className="text-sm text-muted-foreground">{t("notFound")}</p>
        <Link
          href="/flows"
          className="inline-flex min-h-11 items-center rounded-lg px-3 text-sm text-primary outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          {t("backToFlows")}
        </Link>
      </div>
    );
  }

  return <FlowEditorShell initialFlow={flow} initialNodes={nodes} />;
}
