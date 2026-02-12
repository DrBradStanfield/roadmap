import { extension } from "@shopify/ui-extensions/customer-account";

const DEFAULT_URL = "https://drstanfield.com/pages/roadmap";

export default extension(
  "customer-account.profile.block.render",
  (root, api) => {
    const getUrl = () =>
      (api.settings.current?.roadmap_url as string) || DEFAULT_URL;

    const heading = root.createComponent(
      "Heading",
      { level: 2 },
      "Health Roadmap",
    );
    const text = root.createComponent(
      "Text",
      {},
      "View your personalized health suggestions and track your progress over time.",
    );
    const button = root.createComponent(
      "Button",
      { to: getUrl(), kind: "primary" },
      "View your Health Roadmap",
    );

    const stack = root.createComponent("BlockStack", { spacing: "base" }, [
      heading,
      text,
      button,
    ]);

    const card = root.createComponent("Card", { padding: true }, [stack]);

    root.appendChild(card);

    api.settings.subscribe((settings) => {
      button.updateProps({
        to: (settings.roadmap_url as string) || DEFAULT_URL,
      });
    });
  },
);
