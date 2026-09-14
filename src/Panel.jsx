import React, { useEffect, useState, useRef } from "react";
import "./style.css";
const ID = "sk-fuel-usage-mgr-emulator";
export function apiBase() {
  const p = window.location.pathname;
  const marker = p.includes("/admin") ? "/admin" : `/${ID}`;
  const prefix = p.includes(marker) ? p.slice(0, p.indexOf(marker)) : "";
  return `${prefix}/plugins/${ID}`;
}
const initial = {
  timeoutSeconds: 10,
  checkpointSeconds: 30,
  maxFuelRateLph: 1000,
  outputMode: "off",
  providerId: "",
  mappings: [],
};
const liters = (x) =>
  x === null || x === undefined
    ? "—"
    : Number(x).toLocaleString(undefined, { maximumFractionDigits: 2 });
const uid = () =>
  globalThis.crypto?.randomUUID?.() ||
  `${Date.now()}-${Math.random().toString(36).slice(2)}`;
async function request(route, body, signal) {
  const r = await fetch(apiBase() + route, {
    credentials: "include",
    signal,
    ...(body
      ? {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Fuel-Manager": "1",
          },
          body: JSON.stringify(body),
        }
      : {}),
  });
  const data = await r.json();
  if (!r.ok)
    throw new Error(
      data.error ||
        `Request failed (${r.status}). Sign in to Signal K as administrator.`,
    );
  return data;
}
function NumberField({ label, value, onChange, ...props }) {
  return (
    <label>
      {label}
      <input
        type="number"
        step="any"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        {...props}
      />
    </label>
  );
}
function Engine({ e, tanks, act, busy }) {
  return (
    <article className="fdm-card">
      <div className="fdm-row">
        <h3>{e.name}</h3>
        <span className={"fdm-badge " + (e.status === "live" ? "live" : "")}>
          {e.status}
        </span>
      </div>
      <p className="fdm-muted">
        {e.path}
        <br />
        Source: {e.source || "Awaiting first sample"} · Instance{" "}
        {e.instance ?? "unmapped"}
      </p>
      <div className="fdm-metrics">
        <div>
          <strong>{liters(e.tripL)}</strong>
          <span>Trip · L</span>
        </div>
        <div>
          <strong>{liters(e.seasonL)}</strong>
          <span>Season · L</span>
        </div>
        <div>
          <strong>{liters(e.rateLph)}</strong>
          <span>Current · L/h</span>
        </div>
      </div>
      <p>
        Lifetime: {liters(e.totalL)} L · Recorded data gaps: {e.gaps}
      </p>
      <label>
        Fuel supply tank
        <select
          value={e.tankId || ""}
          disabled={busy}
          onChange={(ev) =>
            act({
              action: "mapTank",
              engineId: e.id,
              tankId: ev.target.value || null,
            })
          }
        >
          <option value="">Not assigned</option>
          {tanks.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
      </label>
      <div className="fdm-row">
        <button
          disabled={busy}
          onClick={() =>
            act(
              { action: "reset", engineId: e.id, scope: "trip" },
              `Reset ${e.name} trip fuel? Seasonal fuel and tank inventory will stay unchanged.`,
            )
          }
        >
          Reset trip
        </button>
        <button
          disabled={busy}
          onClick={() =>
            act(
              { action: "reset", engineId: e.id, scope: "season" },
              `Reset ${e.name} seasonal fuel? Trip fuel and tank inventory will stay unchanged.`,
            )
          }
        >
          Reset season
        </button>
      </div>
      {e.sources.length > 1 && (
        <p className="fdm-warning">
          Multiple sources detected. Only the selected source is counted; review
          Settings.
        </p>
      )}
    </article>
  );
}
function Tank({ t, act, busy }) {
  const [amount, setAmount] = useState("");
  return (
    <article className="fdm-card">
      <div className="fdm-row">
        <h3>{t.name}</h3>
        <span className="fdm-badge">Calculated inventory</span>
      </div>
      <p className="fdm-big">
        {liters(t.remainingL)} <small>/ {liters(t.capacityL)} L</small>
      </p>
      <progress
        aria-label={`${t.name} fuel remaining`}
        value={t.remainingL ?? 0}
        max={t.capacityL}
      />
      <p>
        Reserve: {liters(t.reserveL)} L
        {t.remainingL !== null && t.remainingL <= t.reserveL
          ? " · At or below reserve"
          : ""}
      </p>
      <p className="fdm-muted">
        Last marked full:{" "}
        {t.lastFullAt ? new Date(t.lastFullAt).toLocaleString() : "Never"}
      </p>
      <NumberField
        label="Fuel quantity (L)"
        value={amount}
        onChange={setAmount}
        min="0"
        max={t.capacityL}
      />
      <div className="fdm-row">
        <button
          disabled={busy || amount === ""}
          onClick={() =>
            act(
              {
                action: "refuel",
                tankId: t.id,
                mode: "add",
                liters: Number(amount),
              },
              `Add ${amount} L to ${t.name}?`,
            )
          }
        >
          Add fuel
        </button>
        <button
          disabled={busy || amount === ""}
          onClick={() =>
            act(
              {
                action: "refuel",
                tankId: t.id,
                mode: "set",
                liters: Number(amount),
              },
              `Set ${t.name} remaining fuel to ${amount} L?`,
            )
          }
        >
          Set quantity
        </button>
        <button
          className="primary"
          disabled={busy}
          onClick={() =>
            act(
              { action: "refuel", tankId: t.id, mode: "full" },
              `Mark ${t.name} full at ${t.capacityL} L?`,
            )
          }
        >
          Set full
        </button>
      </div>
    </article>
  );
}
export default function Panel({ configuration, save }) {
  const [status, setStatus] = useState(null),
    [error, setError] = useState(""),
    [notice, setNotice] = useState(""),
    [tab, setTab] = useState("Fuel"),
    [busy, setBusy] = useState(false);
  const [settings, setSettings] = useState({ ...initial, ...configuration }),
    [dirty, setDirty] = useState(false);
  const [tank, setTank] = useState({
      id: "main",
      name: "Main tank",
      capacityL: "",
      reserveL: "0",
    }),
    [mark, setMark] = useState("");
  const pending = useRef(null),
    alive = useRef(true),
    inFlight = useRef(false);
  useEffect(() => {
    alive.current = true;
    const controller = new AbortController();
    let timer;
    const poll = async () => {
      try {
        if (!inFlight.current) {
          const s = await request("/status", null, controller.signal);
          if (alive.current && !inFlight.current) setStatus(s);
        }
      } catch (e) {
        if (alive.current && !controller.signal.aborted) setError(e.message);
      } finally {
        if (alive.current) timer = setTimeout(poll, 3000);
      }
    };
    poll();
    return () => {
      alive.current = false;
      controller.abort();
      clearTimeout(timer);
    };
  }, []);
  useEffect(() => {
    if (!dirty)
      setSettings({ ...initial, ...(configuration || status?.configuration) });
  }, [configuration, status?.configuration, dirty]);
  function change(key, value) {
    setDirty(true);
    setSettings((s) => ({ ...s, [key]: value }));
  }
  async function act(body, confirmation) {
    if (inFlight.current || (confirmation && !window.confirm(confirmation)))
      return;
    const signature = JSON.stringify(body);
    if (pending.current?.signature !== signature)
      pending.current = { signature, requestId: uid() };
    inFlight.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const s = await request("/action", {
        ...body,
        requestId: pending.current.requestId,
      });
      setStatus(s);
      pending.current = null;
      setNotice("Saved.");
    } catch (e) {
      setError(
        e.message +
          " If the connection failed, retry the same action; its request ID is retained.",
      );
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  async function saveSettings() {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    const c = {
      ...settings,
      timeoutSeconds: Number(settings.timeoutSeconds),
      checkpointSeconds: Number(settings.checkpointSeconds),
      maxFuelRateLph: Number(settings.maxFuelRateLph),
    };
    try {
      if (save) {
        save(c);
        setNotice(
          "Configuration submitted to Signal K. Check the server save result.",
        );
      } else {
        const next = await request("/settings", { configuration: c });
        setStatus(next);
        setNotice("Configuration saved.");
      }
      setDirty(false);
    } catch (e) {
      setError(e.message);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }
  function mapping(e, key, value) {
    const list = [...settings.mappings];
    let i = list.findIndex((m) => m.path === e.path);
    if (i < 0) {
      list.push({
        path: e.path,
        source: e.source,
        instance: e.instance ?? 0,
        enabled: e.enabled,
      });
      i = list.length - 1;
    }
    list[i] = { ...list[i], [key]: value };
    change("mappings", list);
  }
  const s = status?.state;
  return (
    <div className="fdm">
      <header>
        <div>
          <p className="fdm-eyebrow">SIGNAL K · FUEL ACCOUNTING</p>
          <h2>SK Fuel Usage Manager Emulator</h2>
          <p className="fdm-muted">
            Trip totals, tank inventory and refuelling in one place.
          </p>
        </div>
        <span className="fdm-badge">
          {status?.running ? "Running" : "Stopped / connecting"}
        </span>
      </header>
      <nav aria-label="Fuel manager sections">
        {["Fuel", "Tanks", "History", "Settings", "Diagnostics"].map((t) => (
          <button key={t} aria-pressed={tab === t} onClick={() => setTab(t)}>
            {t}
          </button>
        ))}
      </nav>
      {error && (
        <p role="alert" className="fdm-warning">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      {status?.blocked && (
        <p role="alert" className="fdm-warning">
          {status.blocked} Accounting is paused.{" "}
          <button onClick={() => act({ action: "checkpoint" })}>
            Retry checkpoint
          </button>
        </p>
      )}
      {status?.storageWarning && (
        <p className="fdm-warning">{status.storageWarning}</p>
      )}
      {tab === "Fuel" && (
        <>
          <div className="fdm-row">
            <p>
              Last checkpoint:{" "}
              {status?.lastSave
                ? new Date(status.lastSave).toLocaleString()
                : "Not available"}
            </p>
            <button
              disabled={busy || !s?.engines.length}
              onClick={() =>
                act(
                  { action: "reset", engineId: "all", scope: "trip" },
                  "Reset trip fuel for every engine?",
                )
              }
            >
              Reset all trips
            </button>
          </div>
          {!s?.engines.length ? (
            <div className="fdm-card">
              <h3>Waiting for engine fuel flow</h3>
              <p>
                Engines are discovered automatically from propulsion.*.fuel.rate
                and engine.*.fuel.rate. Existing totals return after restart;
                new consumption requires fresh samples.
              </p>
            </div>
          ) : (
            <div className="fdm-grid">
              {s.engines.map((e) => (
                <Engine
                  key={e.id}
                  e={e}
                  tanks={s.tanks}
                  act={act}
                  busy={busy}
                />
              ))}
            </div>
          )}
          <p className="fdm-muted">
            Data gaps and server downtime can leave consumption uncounted.
            Compare the estimate with fuel added at the next fill.
          </p>
        </>
      )}
      {tab === "Tanks" && (
        <>
          <div className="fdm-grid">
            {s?.tanks.map((t) => (
              <Tank key={t.id} t={t} act={act} busy={busy} />
            ))}
          </div>
          <form
            className="fdm-card"
            onSubmit={(ev) => {
              ev.preventDefault();
              act({
                action: "tank",
                ...tank,
                capacityL: Number(tank.capacityL),
                reserveL: Number(tank.reserveL),
              });
            }}
          >
            <h3>Add or update a tank</h3>
            <p>
              Use the same ID to update capacity. New tanks start with unknown
              fuel; set their initial quantity or mark them full, then assign
              engines on the Fuel page.
            </p>
            <div className="fdm-grid">
              <label>
                Tank ID
                <input
                  required
                  pattern="[A-Za-z0-9_-]{1,64}"
                  value={tank.id}
                  onChange={(e) => setTank({ ...tank, id: e.target.value })}
                />
              </label>
              <label>
                Name
                <input
                  required
                  maxLength="80"
                  value={tank.name}
                  onChange={(e) => setTank({ ...tank, name: e.target.value })}
                />
              </label>
              <NumberField
                label="Capacity (L)"
                value={tank.capacityL}
                onChange={(v) => setTank({ ...tank, capacityL: v })}
                min="0.1"
                required
              />
              <NumberField
                label="Reserve (L)"
                value={tank.reserveL}
                onChange={(v) => setTank({ ...tank, reserveL: v })}
                min="0"
                required
              />
            </div>
            <button disabled={busy} className="primary">
              Save tank
            </button>
          </form>
          <p className="fdm-muted">
            Tank inventory follows the explicitly assigned engines. Tank
            switching is supported by changing the assignment; simultaneous
            split feeds and automatic sender reconciliation are not implemented.
          </p>
        </>
      )}
      {tab === "History" && (
        <div className="fdm-card">
          <h3>Recent activity</h3>
          <p>Latest 500 events. Export a backup to retain a longer history.</p>
          <div className="fdm-table">
            <table>
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Operation</th>
                  <th>Details</th>
                </tr>
              </thead>
              <tbody>
                {s?.history
                  .slice()
                  .reverse()
                  .map((h, i) => (
                    <tr key={i}>
                      <td>{new Date(h.at).toLocaleString()}</td>
                      <td>{h.action}</td>
                      <td>
                        {Object.entries(h)
                          .filter(([k]) => !["at", "action"].includes(k))
                          .map(([k, v]) => `${k}: ${v}`)
                          .join(" · ")}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      {tab === "Settings" && (
        <div className="fdm-card">
          <h3>Accounting and N2K output</h3>
          <div className="fdm-grid">
            <NumberField
              label="Sample timeout (seconds)"
              value={settings.timeoutSeconds}
              onChange={(v) => change("timeoutSeconds", v)}
              min="1"
              max="300"
            />
            <NumberField
              label="Checkpoint interval (seconds)"
              value={settings.checkpointSeconds}
              onChange={(v) => change("checkpointSeconds", v)}
              min="1"
              max="3600"
            />
            <NumberField
              label="Maximum engine flow (L/h)"
              value={settings.maxFuelRateLph}
              onChange={(v) => change("maxFuelRateLph", v)}
              min="1"
              max="100000"
            />
            <label>
              N2K output
              <select
                value={settings.outputMode}
                onChange={(e) => change("outputMode", e.target.value)}
              >
                <option value="off">Off — SK accounting only</option>
                <option value="provider">
                  Existing provider — direct PGNs
                </option>
                <option value="device">Virtual SK fuel device</option>
              </select>
            </label>
            <label>
              Provider ID (virtual device)
              <input
                value={settings.providerId}
                onChange={(e) => change("providerId", e.target.value)}
              />
            </label>
          </div>
          <p>
            Output sends standard engine trip fuel (127497) and configured
            vessel fuel remaining (127496). B&G acceptance requires an on-board
            test. Proprietary seasonal output is not implemented. Disable
            overlapping Cannon fuel outputs before enabling this output.
          </p>
          <h3>Engine sources and instances</h3>
          <p>
            Sources are pinned automatically. Resolve aliases by disabling
            duplicates; each enabled engine must have a unique N2K instance.
          </p>
          <div className="fdm-table">
            <table>
              <thead>
                <tr>
                  <th>Engine path</th>
                  <th>Source</th>
                  <th>Instance</th>
                  <th>Count engine</th>
                </tr>
              </thead>
              <tbody>
                {(s?.engines || []).map((e) => {
                  const m =
                    settings.mappings.find((m) => m.path === e.path) || e;
                  return (
                    <tr key={e.id}>
                      <td>{e.path}</td>
                      <td>
                        <input
                          aria-label={`${e.name} source`}
                          value={m.source}
                          onChange={(ev) =>
                            mapping(e, "source", ev.target.value)
                          }
                        />
                      </td>
                      <td>
                        <input
                          aria-label={`${e.name} instance`}
                          type="number"
                          min="0"
                          max="252"
                          value={m.instance ?? 0}
                          onChange={(ev) =>
                            mapping(e, "instance", Number(ev.target.value))
                          }
                        />
                      </td>
                      <td>
                        <input
                          aria-label={`Count ${e.name}`}
                          type="checkbox"
                          checked={m.enabled}
                          onChange={(ev) =>
                            mapping(e, "enabled", ev.target.checked)
                          }
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <button
            className="primary"
            disabled={busy || !dirty}
            onClick={saveSettings}
          >
            Save configuration
          </button>
        </div>
      )}
      {tab === "Diagnostics" && (
        <div className="fdm-card">
          <h3>Output and recovery</h3>
          <p>{status?.n2k.status}</p>
          <p>
            Messages submitted: {status?.n2k.submitted || 0}. This is not
            confirmation of delivery on the bus.
          </p>
          <p>
            Available providers: {JSON.stringify(status?.n2k.providers || [])}
          </p>
          <div className="fdm-row">
            <a href={apiBase() + "/backup"}>Download state backup</a>
            <button
              disabled={busy}
              onClick={() => act({ action: "checkpoint" })}
            >
              Save checkpoint now
            </button>
            <label>
              Restore backup
              <input
                type="file"
                accept="application/json,.json"
                onChange={async (ev) => {
                  const file = ev.target.files?.[0];
                  if (!file) return;
                  try {
                    if (file.size > 1000000)
                      throw new Error("Backup exceeds 1 MB");
                    const state = JSON.parse(await file.text());
                    await act(
                      { action: "restore", state },
                      "Replace all fuel counters and tank inventory with this backup?",
                    );
                  } catch (e) {
                    setError(e.message);
                  }
                  ev.target.value = "";
                }}
              />
            </label>
          </div>
          <h3>N2K capture</h3>
          <p>
            Optional two-minute recording for compatibility investigation.
            Records decoded messages and unparsed data exposed by the provider;
            this is not guaranteed to contain every raw CAN frame.
          </p>
          <p>
            {status?.capture.active ? "Recording" : "Stopped"} ·{" "}
            {status?.capture.count || 0} records ·{" "}
            {status?.capture.dropped || 0} dropped
          </p>
          <div className="fdm-row">
            <button
              disabled={busy}
              onClick={() =>
                act(
                  { action: "captureStart" },
                  "Start a new capture and replace the previous recording?",
                )
              }
            >
              Start recording
            </button>
            <button
              disabled={busy}
              onClick={() => act({ action: "captureStop" })}
            >
              Stop
            </button>
            <a href={apiBase() + "/capture"}>Download capture</a>
          </div>
          <label>
            Action marker
            <input
              value={mark}
              onChange={(e) => setMark(e.target.value)}
              maxLength="120"
            />
          </label>
          <button
            disabled={busy || !status?.capture.active}
            onClick={() => act({ action: "captureMark", label: mark })}
          >
            Mark action
          </button>
          <p>
            Resets and refuelling are controlled here in SK. No received N2K
            message can reset your counters.
          </p>
        </div>
      )}
    </div>
  );
}
