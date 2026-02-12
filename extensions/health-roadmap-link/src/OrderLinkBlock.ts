import { extension } from "@shopify/ui-extensions/customer-account";

export default extension(
  "customer-account.order-index.block.render",
  (root) => {
    const heading = root.createComponent("Heading", { level: 2 }, "Health Roadmap");
    const text = root.createComponent(
      "Text",
      {},
      "View your personalized health suggestions and track your progress over time.",
    );
    const button = root.createComponent(
      "Button",
      { to: "https://drstanfield.com/pages/roadmap", kind: "primary" },
      "View your Health Roadmap",
    );

    const stack = root.createComponent("BlockStack", { spacing: "base" }, [
      heading,
      text,
      button,
    ]);

    const card = root.createComponent("Card", { padding: true }, [stack]);

    root.appendChild(card);
  },
);
