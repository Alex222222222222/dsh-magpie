window.__ModuleLoader__.load({
	id: "@alex222222222222/magpie",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const { createElement: h, useEffect, useState } = require("react");
		const { Button, Input, SegmentedControl, Switch } = require("@deepseek-ai/dsh-client-ui-primitives");

		// Copy for the Magpie configuration page.
		const en = {
			title: "Magpie",
			description: "Set the Magpie gateway this plugin calls for image analysis.",
			gatewayUrl: "Gateway URL",
			gatewayUrlHint: "Base URL of the Magpie gateway; the plugin appends mcp/magpie/vision.",
			tokenEnv: "Token environment variable",
			tokenEnvHint: "Name of the Host environment variable that holds the bearer key.",
			instructionMode: "Agent instructions",
			instructionModeHint: "normal adds no prompt text; suggest recommends the tool; force requires using it for image inspection.",
			allowInsecureHttp: "Allow plain HTTP",
			allowInsecureHttpHint: "Permit an http gateway; the bearer key will travel unencrypted.",
			webSearchHeading: "Web search",
			webSearchEnabled: "Enable web search",
			webSearchEnabledHint: "Connect to the Magpie web search endpoint and expose search tools to agents.",
			webSearchInstructionMode: "Web search instructions",
			webSearchInstructionModeHint: "normal adds no prompt text; suggest recommends search tools; force requires using them for web research.",
			invalidGateway: "Enter an absolute http or https URL.",
			invalidTokenEnv: "Enter an environment-variable name (letters, digits, underscore).",
			save: "Save",
			discard: "Discard",
			unavailable: "This deployment does not serve Magpie settings.",
			readOnly: "This deployment stores settings read-only.",
			saved: "Saved.",
			refused: "The deployment did not accept these values; they were left for you to correct."
		};
		const zh = {
			title: "Magpie",
			description: "设置本插件做图像分析时调用的 Magpie 网关。",
			gatewayUrl: "网关地址",
			gatewayUrlHint: "Magpie 网关的基础地址；插件会自动追加 mcp/magpie/vision。",
			tokenEnv: "令牌环境变量",
			tokenEnvHint: "存放 bearer 密钥的宿主环境变量名。",
			instructionMode: "Agent 指令",
			instructionModeHint: "normal 不添加系统提示；suggest 推荐使用；force 强制要求在图像分析时使用。",
			allowInsecureHttp: "允许明文 HTTP",
			allowInsecureHttpHint: "允许 http 网关；此时 bearer 密钥将明文传输。",
			webSearchHeading: "网页搜索",
			webSearchEnabled: "启用网页搜索",
			webSearchEnabledHint: "连接 Magpie 网页搜索端点并向 Agent 提供搜索工具。",
			webSearchInstructionMode: "网页搜索指令",
			webSearchInstructionModeHint: "normal 不添加系统提示；suggest 推荐使用；force 强制要求在网页调研时使用。",
			invalidGateway: "请填写 http 或 https 绝对地址。",
			invalidTokenEnv: "请填写合法的环境变量名（字母、数字、下划线）。",
			save: "保存",
			discard: "放弃",
			unavailable: "本部署未提供 Magpie 设置。",
			readOnly: "本部署的设置为只读。",
			saved: "已保存。",
			refused: "本部署没有接受这些值，已保留供你修改。"
		};

		const NS = "settings.magpie";
		const PKG = "@alex222222222222/magpie";
		const ROW = "magpie";
		const FIELD_ORDER = ["gatewayUrl", "tokenEnv", "instructionMode", "allowInsecureHttp", "webSearchEnabled", "webSearchInstructionMode"];
		const MODES = ["normal", "suggest", "force"];

		/** One field's stored value from the form snapshot, unwrapping the section object. */
		function storedValue(state, field) {
			const value = state?.value;
			return value !== null && typeof value === "object" ? value[field] : undefined;
		}

		/** Draft text for one field, matching how the field renders its stored value. */
		function draftText(value, field) {
			if (value === undefined || value === null) {
				if (field === "webSearchEnabled") return "false";
				if (field === "webSearchInstructionMode") return "normal";
				return "";
			}
			if (field === "allowInsecureHttp" || field === "webSearchEnabled") return value === true ? "true" : "false";
			return String(value);
		}

		/** The write one field's draft stages, or undefined when the draft is not acceptable. */
		function parse(field, text) {
			const trimmed = (text ?? "").trim();
			if (field === "gatewayUrl") {
				if (trimmed === "") return { op: "unset", path: [field] };
				return /^https?:\/\/\S+$/i.test(trimmed) ? { op: "set", path: [field], value: trimmed } : undefined;
			}
			if (field === "tokenEnv") {
				if (trimmed === "") return { op: "unset", path: [field] };
				return /^[A-Za-z_][A-Za-z0-9_]*$/.test(trimmed) ? { op: "set", path: [field], value: trimmed } : undefined;
			}
			if (field === "instructionMode" || field === "webSearchInstructionMode") {
				return MODES.includes(trimmed) ? { op: "set", path: [field], value: trimmed } : undefined;
			}
			return trimmed === "true" || trimmed === "false" ? { op: "set", path: [field], value: trimmed === "true" } : undefined;
		}

		/** The page's staged drafts, reset whenever the Host snapshot replaces its accepted value. */
		function ConfigurationPage({ t, view, form }) {
			const state = form?.state;
			const ready = state?.status === "ready";
			const initialDrafts = () => Object.fromEntries(FIELD_ORDER.map((field) => [field, draftText(storedValue(state, field), field)]));
			const [drafts, setDrafts] = useState(() => (ready ? initialDrafts() : {}));
			const [notice, setNotice] = useState(null);
			const [saving, setSaving] = useState(false);
			const revision = state?.revision;

			useEffect(() => {
				if (!ready) return;
				setDrafts(initialDrafts());
				setNotice(null);
			}, [ready, revision]);

			if (view === "summary") return t("description");
			if (form === undefined || state === undefined) return null;
			if (!ready) return h("p", null, state.status === "unavailable" ? t("unavailable") : null);

			const disabled = !state.writable || saving;
			const parsed = FIELD_ORDER.map((field) => parse(field, drafts[field] ?? ""));
			const invalid = Object.fromEntries(FIELD_ORDER.map((field, index) => [field, parsed[index] === undefined]));
			const hasInvalid = parsed.some((op) => op === undefined);

			const save = async () => {
				const ops = parsed.filter((op) => op !== undefined);
				if (ops.length === 0 || hasInvalid) return;
				setSaving(true);
				try {
					const accepted = await form.mutate(ops, revision);
					setNotice(accepted ? "saved" : "refused");
				} finally {
					setSaving(false);
				}
			};

			const discard = () => {
				setDrafts(Object.fromEntries(FIELD_ORDER.map((field) => [field, draftText(storedValue(state, field), field)])));
				setNotice(null);
			};

			const fieldStyle = { display: "flex", flexDirection: "column", gap: "6px", marginBottom: "16px" };
			const labelStyle = { fontSize: "13px", fontWeight: 600 };
			const hintStyle = { fontSize: "12px", opacity: 0.7, margin: 0 };
			const errorStyle = { fontSize: "12px", color: "var(--dsw-alias-intent-danger, #d32f2f)", margin: 0 };

			return h("div", { "data-magpie-config-page": true, style: { display: "flex", flexDirection: "column", maxWidth: "560px", padding: "12px 0" } },
				h("p", { style: { fontSize: "13px", opacity: 0.8, marginBottom: "16px" } }, t("description")),

				// Gateway URL (Text Input)
				h("div", { style: fieldStyle, "data-field": "gatewayUrl" },
					h("label", { style: labelStyle, htmlFor: "magpie-gateway-url" }, t("gatewayUrl")),
					h(Input, {
						id: "magpie-gateway-url",
						value: drafts.gatewayUrl ?? "",
						placeholder: "https://magpie-gateway.alex1222.com/",
						disabled,
						onChange: (e) => setDrafts((curr) => ({ ...curr, gatewayUrl: e.target.value }))
					}),
					invalid.gatewayUrl
						? h("p", { style: errorStyle, role: "alert" }, t("invalidGateway"))
						: h("p", { style: hintStyle }, t("gatewayUrlHint"))
				),

				// Token Environment Variable (Text Input)
				h("div", { style: fieldStyle, "data-field": "tokenEnv" },
					h("label", { style: labelStyle, htmlFor: "magpie-token-env" }, t("tokenEnv")),
					h(Input, {
						id: "magpie-token-env",
						value: drafts.tokenEnv ?? "",
						placeholder: "MAGPIE_API_KEY",
						disabled,
						onChange: (e) => setDrafts((curr) => ({ ...curr, tokenEnv: e.target.value }))
					}),
					invalid.tokenEnv
						? h("p", { style: errorStyle, role: "alert" }, t("invalidTokenEnv"))
						: h("p", { style: hintStyle }, t("tokenEnvHint"))
				),

				// Instruction Mode (Segmented Control)
				h("div", { style: fieldStyle, "data-field": "instructionMode" },
					h("label", { style: labelStyle }, t("instructionMode")),
					h(SegmentedControl, {
						id: "magpie-instruction-mode",
						value: drafts.instructionMode || "normal",
						options: MODES.map((mode) => ({ value: mode, label: mode })),
						onChange: (mode) => setDrafts((curr) => ({ ...curr, instructionMode: mode })),
						label: t("instructionMode"),
						disabled
					}),
					h("p", { style: hintStyle }, t("instructionModeHint"))
				),

				// Allow Plain HTTP (Switch)
				h("div", { style: { ...fieldStyle, flexDirection: "row", alignItems: "center", justifyContent: "space-between" }, "data-field": "allowInsecureHttp" },
					h("div", { style: { display: "flex", flexDirection: "column", gap: "2px" } },
						h("span", { style: labelStyle }, t("allowInsecureHttp")),
						h("p", { style: hintStyle }, t("allowInsecureHttpHint"))
					),
					h(Switch, {
						checked: drafts.allowInsecureHttp === "true",
						onChange: (checked) => setDrafts((curr) => ({ ...curr, allowInsecureHttp: checked ? "true" : "false" })),
						label: t("allowInsecureHttp"),
						disabled
					})
				),

				// Web Search Section
				h("div", { style: { marginTop: "8px", paddingTop: "16px", borderTop: "1px solid var(--dsw-alias-border-subtle, rgba(128, 128, 128, 0.2))" } },
					h("h3", { style: { fontSize: "14px", fontWeight: 600, margin: "0 0 12px 0" } }, t("webSearchHeading")),

					// Web Search Enabled (Switch)
					h("div", { style: { ...fieldStyle, flexDirection: "row", alignItems: "center", justifyContent: "space-between" }, "data-field": "webSearchEnabled" },
						h("div", { style: { display: "flex", flexDirection: "column", gap: "2px" } },
							h("span", { style: labelStyle }, t("webSearchEnabled")),
							h("p", { style: hintStyle }, t("webSearchEnabledHint"))
						),
						h(Switch, {
							checked: drafts.webSearchEnabled === "true",
							onChange: (checked) => setDrafts((curr) => ({ ...curr, webSearchEnabled: checked ? "true" : "false" })),
							label: t("webSearchEnabled"),
							disabled
						})
					),

					// Web Search Instruction Mode (Segmented Control)
					h("div", { style: fieldStyle, "data-field": "webSearchInstructionMode" },
						h("label", { style: labelStyle }, t("webSearchInstructionMode")),
						h(SegmentedControl, {
							id: "magpie-web-search-instruction-mode",
							value: drafts.webSearchInstructionMode || "normal",
							options: MODES.map((mode) => ({ value: mode, label: mode })),
							onChange: (mode) => setDrafts((curr) => ({ ...curr, webSearchInstructionMode: mode })),
							label: t("webSearchInstructionMode"),
							disabled
						}),
						h("p", { style: hintStyle }, t("webSearchInstructionModeHint"))
					)
				),

				// Action buttons
				h("div", { style: { display: "flex", gap: "8px", marginTop: "12px", alignItems: "center" } },
					h(Button, { variant: "primary", size: "sm", disabled: disabled || hasInvalid, onClick: save }, t("save")),
					h(Button, { variant: "outline", size: "sm", disabled: saving, onClick: discard }, t("discard")),
					notice === null ? null : h("span", { role: "status", style: { fontSize: "13px", marginLeft: "8px" } }, t(notice))
				),

				!state.writable ? h("p", { style: { ...hintStyle, marginTop: "8px" } }, t("readOnly")) : null
			);
		}

		const inject = ["slots", "locale"];

		function apply(ctx) {
			const t = ctx.locale.bind(NS);
			ctx.effect(() => ctx.locale.register(NS, { en, zh }), "magpie: settings copy");
			ctx.effect(() => ctx.slots.inject("plugins.row.config", () => ctx.slots.register({
				name: "plugins.row.config",
				key: `${PKG}#${ROW}`,
				locale: NS,
			}, ConfigurationPage)), "magpie: settings page");
		}

		exports.NS = NS;
		exports.apply = apply;
		exports.inject = inject;
		exports.ConfigurationPage = ConfigurationPage;
		return module.exports;
	}
});
