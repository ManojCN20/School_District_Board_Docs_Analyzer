import { analyzeDistrictPresence, withDistrictTimeout } from "./analyzers/stage1.js";

process.on("message", async (message) => {
  if (message?.type !== "run" || !message.district) {
    return;
  }

  try {
    const result = await withDistrictTimeout(
      analyzeDistrictPresence(message.district),
      message.district.districtName,
    );

    process.send?.({
      type: "result",
      result,
    });
    process.exit(0);
  } catch (error) {
    process.send?.({
      type: "error",
      error:
        error instanceof Error ? error.message : "The district analysis process failed unexpectedly.",
    });
    process.exit(1);
  }
});
