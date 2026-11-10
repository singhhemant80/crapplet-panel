"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { Button, Icon, cx } from "./ui";

type RFBType = {
  scaleViewport: boolean;
  resizeSession: boolean;
  focusOnClick: boolean;
  disconnect(): void;
  sendCtrlAltDel(): void;
  focus(): void;
  clipboardPasteFrom(text: string): void;
  addEventListener(ev: string, fn: (e: any) => void): void;
};

/**
 * In-browser VPS console (noVNC). Asks the panel for a one-time console session, then connects to the
 * panel's websocket relay, which talks to the Virtualizor master.
 */
export function VncConsole({ sessionPath, title }: { sessionPath: string; title: string }) {
  const screen = useRef<HTMLDivElement>(null);
  const frame = useRef<HTMLDivElement>(null);
  const rfb = useRef<RFBType | null>(null);
  const [state, setState] = useState<"connecting" | "connected" | "disconnected" | "error">("connecting");
  const [msg, setMsg] = useState("Opening console…");
  const [paste, setPaste] = useState("");
  const [n, setN] = useState(0);

  const connect = useCallback(async () => {
    setState("connecting");
    setMsg("Opening console…");
    try {
      const s = await api<{ path: string; password: string }>(sessionPath, { body: {} });
      // `next dev` doesn't proxy websockets — talk to the API port directly there
      const origin = process.env.NEXT_PUBLIC_CONSOLE_WS_ORIGIN || `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}`;
      const { default: RFB } = (await import("@novnc/novnc/lib/rfb")) as { default: new (el: HTMLElement, url: string, opts: object) => RFBType };
      if (!screen.current) return;
      screen.current.innerHTML = "";
      const r = new RFB(screen.current, `${origin}${s.path}`, { credentials: { password: s.password }, wsProtocols: ["binary"] });
      r.scaleViewport = true;
      r.resizeSession = false;
      r.focusOnClick = true;
      r.addEventListener("connect", () => {
        setState("connected");
        setMsg("Connected");
        r.focus();
      });
      r.addEventListener("disconnect", (e: any) => {
        setState(e?.detail?.clean ? "disconnected" : "error");
        setMsg(e?.detail?.clean ? "Disconnected" : "The console connection was closed. Is the VPS running and VNC enabled?");
      });
      r.addEventListener("securityfailure", (e: any) => {
        setState("error");
        setMsg(`Console login failed${e?.detail?.reason ? `: ${e.detail.reason}` : ""}`);
      });
      rfb.current = r;
    } catch (e: any) {
      setState("error");
      setMsg(e.message ?? "Couldn't open the console");
    }
  }, [sessionPath]);

  useEffect(() => {
    connect();
    return () => rfb.current?.disconnect();
  }, [connect, n]);

  const reconnect = () => {
    rfb.current?.disconnect();
    setN((x) => x + 1);
  };

  return (
    <div ref={frame} className="flex h-[calc(100vh-170px)] min-h-[420px] flex-col overflow-hidden rounded-2xl border border-slate-800 bg-slate-950 shadow-card">
      <div className="flex flex-wrap items-center gap-2 border-b border-slate-800 bg-slate-900 px-3 py-2">
        <span className={cx("h-2.5 w-2.5 rounded-full", state === "connected" ? "bg-emerald-400" : state === "connecting" ? "animate-pulse bg-amber-400" : "bg-rose-500")} />
        <span className="mr-auto truncate text-sm font-bold text-slate-100">{title}</span>
        <span className="hidden text-xs text-slate-400 sm:inline">{msg}</span>
        <Button size="sm" variant="ghost" className="!text-slate-200 hover:!bg-slate-800" icon="keyboard" disabled={state !== "connected"} onClick={() => rfb.current?.sendCtrlAltDel()}>Ctrl+Alt+Del</Button>
        <Button size="sm" variant="ghost" className="!text-slate-200 hover:!bg-slate-800" icon="fullscreen" onClick={() => frame.current?.requestFullscreen?.()}>Full screen</Button>
        <Button size="sm" variant="ghost" className="!text-slate-200 hover:!bg-slate-800" icon="refresh" onClick={reconnect}>Reconnect</Button>
      </div>
      <div className="relative min-h-0 flex-1">
        <div ref={screen} className="absolute inset-0" />
        {state !== "connected" && (
          <div className="pointer-events-none absolute inset-0 grid place-items-center p-6 text-center">
            <div className="max-w-md">
              {state === "connecting" ? <span className="mx-auto mb-3 block h-8 w-8 animate-spin rounded-full border-4 border-slate-600 border-t-white" /> : <Icon name={state === "error" ? "error" : "power_off"} className="mb-2 text-[36px] text-slate-400" />}
              <p className="text-sm text-slate-300">{msg}</p>
            </div>
          </div>
        )}
      </div>
      <div className="flex items-center gap-2 border-t border-slate-800 bg-slate-900 px-3 py-2">
        <input value={paste} onChange={(e) => setPaste(e.target.value)} placeholder="Type or paste text to send to the server…" className="h-8 min-w-0 flex-1 rounded-lg border border-slate-700 bg-slate-950 px-3 text-sm text-slate-100 outline-none placeholder:text-slate-500 focus:border-primary" />
        <Button size="sm" disabled={state !== "connected" || !paste} onClick={() => { typeText(rfb.current, paste); setPaste(""); }}>Send</Button>
      </div>
    </div>
  );
}

/** Types text into the console key by key (noVNC's clipboard isn't read by most OS consoles). */
function typeText(r: any, text: string) {
  if (!r) return;
  for (const ch of text) {
    const code = ch === "\n" ? 0xff0d : ch.charCodeAt(0);
    r.sendKey(code, null, true);
    r.sendKey(code, null, false);
  }
  r.focus();
}
