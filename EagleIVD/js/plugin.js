// plugin.js
import { initializeUI } from "./ui.js";

eagle.onPluginCreate(async (plugin) => {
  console.log("onPluginCreate triggered");
  await initializeUI(plugin);
});

eagle.onPluginRun(() => {
  console.log("eagle.onPluginRun triggered");
});
