"use client";

import { createContext, useCallback, useContext, useMemo, useSyncExternalStore } from "react";

import { getAccountModules } from "@/lib/verticals/registry";
import { useAuth } from "@/hooks/use-auth";

const PREVIEW_KEY = "shift:preview-as-business";
const PREVIEW_EVENT = "shift:preview-change";

function readPreview(): boolean {
  try {
    return window.localStorage.getItem(PREVIEW_KEY) === "1";
  } catch {
    return false;
  }
}

function subscribePreview(onChange: () => void): () => void {
  window.addEventListener(PREVIEW_EVENT, onChange);
  window.addEventListener("storage", onChange);
  return () => {
    window.removeEventListener(PREVIEW_EVENT, onChange);
    window.removeEventListener("storage", onChange);
  };
}

interface ViewModeValue {
  /** True cuando la pantalla es la del local (vista sencilla). */
  simple: boolean;
  /** El usuario es del equipo de Shift (puede alternar la vista). */
  isShiftStaff: boolean;
  /** Shift viendo la app como la ve el local. */
  previewAsBusiness: boolean;
  setPreviewAsBusiness: (value: boolean) => void;
  /** La cuenta tiene un módulo (agenda, ventas…). */
  hasModules: boolean;
}

const ViewModeContext = createContext<ViewModeValue>({
  simple: true,
  isShiftStaff: false,
  previewAsBusiness: false,
  setPreviewAsBusiness: () => {},
  hasModules: false,
});

export function ViewModeProvider({
  isShiftStaff,
  children,
}: {
  isShiftStaff: boolean;
  children: React.ReactNode;
}) {
  const { account } = useAuth();
  const previewAsBusiness = useSyncExternalStore(
    subscribePreview,
    readPreview,
    () => false,
  );

  const setPreviewAsBusiness = useCallback((value: boolean) => {
    try {
      if (value) window.localStorage.setItem(PREVIEW_KEY, "1");
      else window.localStorage.removeItem(PREVIEW_KEY);
    } catch {
      // Sin almacenamiento (modo privado): no se puede recordar.
    }
    window.dispatchEvent(new Event(PREVIEW_EVENT));
  }, []);

  const value = useMemo<ViewModeValue>(
    () => ({
      simple: !isShiftStaff || previewAsBusiness,
      isShiftStaff,
      previewAsBusiness: isShiftStaff && previewAsBusiness,
      setPreviewAsBusiness,
      hasModules: getAccountModules(account).length > 0,
    }),
    [account, isShiftStaff, previewAsBusiness, setPreviewAsBusiness],
  );

  return <ViewModeContext.Provider value={value}>{children}</ViewModeContext.Provider>;
}

export function useViewMode(): ViewModeValue {
  return useContext(ViewModeContext);
}
