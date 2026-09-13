import React from "react";
import { createRoot } from "react-dom/client";
const script = document.createElement("script");
script.src = "/fuel-usage-calculator/remoteEntry.js";
document.head.appendChild(script);
script.onload = async () => {
  try {
    await window.fuel_usage_calculator.init({
      react: {
        "19.0.0": { get: () => () => React, loaded: true, from: "sk-host" },
      },
    });
    const factory = await window.fuel_usage_calculator.get(
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
