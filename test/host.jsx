import React from "react";
import { createRoot } from "react-dom/client";
const script = document.createElement("script");
script.src = "/sk-fuel-usage-mgr-emulator/remoteEntry.js";
document.head.appendChild(script);
script.onload = async () => {
  try {
    await window.sk_fuel_usage_mgr_emulator.init({
      react: {
        "19.0.0": { get: () => () => React, loaded: true, from: "sk-host" },
      },
    });
    const factory = await window.sk_fuel_usage_mgr_emulator.get(
      "./PluginConfigurationPanel",
    );
    const Panel = factory().default;
    createRoot(document.getElementById("root")).render(
      <Panel
        configuration={{ outputMode: "off" }}
        save={(c) => {
          window.savedConfig = c;
        }}
      />,
    );
  } catch (e) {
    window.hostError = e.message;
  }
};
