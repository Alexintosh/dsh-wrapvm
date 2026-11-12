window.__ModuleLoader__.load({
	id: "@deepseek-ai/dsh-wrapvm-isolate",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let zod = require("zod");
		let react_jsx_runtime = require("react/jsx-runtime");
		let _deepseek_ai_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		let react = require("react");
		//#region ../../typert/protocol/lib/types/remote-info.js
		/** Lazy assembly of generated Remote definitions using caller-supplied Zod; no runtime imports. */
		/**
		* Retain one generated definition per endpoint without constructing parsers or projections.
		* The class instance builds its shared descriptor/method index on first access;
		* input schemas and JSON Schema projections are cached only when requested.
		* @param spec - compiler-produced method facts and Zod factories.
		* @param zod - the generated artifact's Zod runtime for named-input parsers.
		* @returns a lazy, mountable info instance with no registration or transport effects.
		*/
		function createTypertRemoteInfo(spec, zod) {
			return new RemoteInfo(spec, zod);
		}
		var RemoteInfo = class {
			spec;
			zod;
			index;
			constructor(spec, zod) {
				this.spec = spec;
				this.zod = zod;
			}
			get package() {
				return this.spec.package;
			}
			get descriptors() {
				return this.resolve().descriptors;
			}
			get methods() {
				return this.resolve().methods;
			}
			resolve() {
				if (this.index !== void 0) return this.index;
				const zod = this.zod;
				const descriptors = [];
				const methods = Object.create(null);
				for (const [endpoint, definition] of Object.entries(this.spec.methods)) {
					const separator = endpoint.indexOf("/");
					const namespace = endpoint.slice(0, separator);
					const method = endpoint.slice(separator + 1);
					const parameters = definition.parameters.map((parameter) => ({
						...parameter,
						wire: parameter.wire ?? parameter.name
					}));
					const descriptor = {
						...definition,
						id: `${this.spec.package}#${endpoint}`,
						namespace,
						method,
						parameters,
						result: definition.result.description === void 0 ? definition.result : new ResultValue(definition.result)
					};
					if (definition.invocation.kind === "direct") {
						const inputs = [];
						methods[endpoint] = Object.assign(descriptor, {
							input(options) {
								const strict = options?.strict === true;
								return inputs[strict ? 1 : 0] ??= new NamedInput(parameters, strict, zod);
							},
							invoke(remote, input, signal) {
								const named = input;
								const values = parameters.map((parameter) => named[parameter.wire]);
								if (definition.cancellation !== void 0) values.push(signal);
								const receiver = Reflect.get(remote, namespace);
								return Reflect.get(receiver, method).apply(receiver, values);
							}
						});
					}
					descriptors.push(descriptor);
				}
				return this.index = {
					descriptors,
					methods
				};
			}
		};
		function optional(parameter) {
			return parameter.source === "json" && parameter.acceptsUndefined === true;
		}
		var NamedInput = class {
			parameters;
			strict;
			zod;
			schema;
			projection;
			constructor(parameters, strict, zod) {
				this.parameters = parameters;
				this.strict = strict;
				this.zod = zod;
			}
			codec(parameter) {
				return this.strict ? parameter.strictCodec : parameter.codec;
			}
			create = () => this.schema ??= this.zod.strictObject(Object.fromEntries(this.parameters.map((parameter) => {
				const value = this.codec(parameter).create();
				return [parameter.wire, optional(parameter) ? value.optional() : value.nonoptional()];
			})));
			get jsonSchema() {
				return this.project().jsonSchema;
			}
			get jsonSchemaError() {
				return this.project().jsonSchemaError;
			}
			project() {
				if (this.projection !== void 0) return this.projection;
				const unavailable = this.parameters.find((parameter) => this.codec(parameter).jsonSchema === void 0);
				if (unavailable !== void 0) return this.projection = { jsonSchemaError: this.codec(unavailable).jsonSchemaError ?? `No JSON Schema for parameter ${unavailable.wire}` };
				return this.projection = { jsonSchema: {
					type: "object",
					properties: Object.fromEntries(this.parameters.map((parameter) => [parameter.wire, {
						...this.codec(parameter).jsonSchema,
						...parameter.description === void 0 ? {} : { description: parameter.description }
					}])),
					required: this.parameters.filter((parameter) => !optional(parameter)).map((parameter) => parameter.wire),
					additionalProperties: false
				} };
			}
		};
		var ResultValue = class {
			spec;
			projection;
			constructor(spec) {
				this.spec = spec;
			}
			get mode() {
				return this.spec.mode;
			}
			get typeSymbol() {
				return this.spec.typeSymbol;
			}
			get create() {
				return this.spec.create;
			}
			get decode() {
				return this.spec.decode;
			}
			get encode() {
				return this.spec.encode;
			}
			get description() {
				return this.spec.description;
			}
			get jsonSchemaError() {
				return this.spec.jsonSchemaError;
			}
			get jsonSchema() {
				if (this.projection === void 0) {
					const schema = this.spec.jsonSchema;
					this.projection = { value: schema === void 0 ? void 0 : {
						...schema,
						description: this.spec.description
					} };
				}
				return this.projection.value;
			}
		};
		//#endregion
		//#region lib/typert.remote-client.js
		let _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02Bind_parameter_0$schema$value;
		const _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02Bind_parameter_0$schema = () => _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02Bind_parameter_0$schema$value ??= zod.z.string();
		let _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02Bind_parameter_1$schema$value;
		const _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02Bind_parameter_1$schema = () => _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02Bind_parameter_1$schema$value ??= zod.z.string();
		let _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02Bind_parameter_2$schema$value;
		const _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02Bind_parameter_2$schema = () => _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02Bind_parameter_2$schema$value ??= zod.z.string();
		let _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02Bind_result$schema$value;
		const _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02Bind_result$schema = () => _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02Bind_result$schema$value ??= zod.z.object({
			"id": zod.z.string().readonly(),
			"environmentId": zod.z.string().readonly(),
			"kind": zod.z.string().readonly(),
			"state": zod.z.union([
				zod.z.literal("running"),
				zod.z.literal("requested"),
				zod.z.literal("completed"),
				zod.z.literal("failed")
			]).readonly(),
			"error": zod.z.union([zod.z.literal(null), zod.z.string()]).readonly(),
			"errorCode": zod.z.union([zod.z.literal(null), zod.z.string()]).readonly(),
			"requestedAt": zod.z.union([zod.z.literal(null), zod.z.number()]).readonly(),
			"settledAt": zod.z.union([zod.z.literal(null), zod.z.number()]).readonly()
		});
		let _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02ConfirmRemoval_parameter_0$schema$value;
		const _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02ConfirmRemoval_parameter_0$schema = () => _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02ConfirmRemoval_parameter_0$schema$value ??= zod.z.string();
		let _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02ConfirmRemoval_parameter_1$schema$value;
		const _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02ConfirmRemoval_parameter_1$schema = () => _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02ConfirmRemoval_parameter_1$schema$value ??= zod.z.string();
		let _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02ConfirmRemoval_parameter_2$schema$value;
		const _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02ConfirmRemoval_parameter_2$schema = () => _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02ConfirmRemoval_parameter_2$schema$value ??= zod.z.boolean();
		let _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02ConfirmRemoval_parameter_3$schema$value;
		const _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02ConfirmRemoval_parameter_3$schema = () => _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02ConfirmRemoval_parameter_3$schema$value ??= zod.z.string();
		let _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02ConfirmRemoval_result$schema$value;
		const _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02ConfirmRemoval_result$schema = () => _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02ConfirmRemoval_result$schema$value ??= zod.z.object({
			"id": zod.z.string().readonly(),
			"environmentId": zod.z.string().readonly(),
			"kind": zod.z.string().readonly(),
			"state": zod.z.union([
				zod.z.literal("running"),
				zod.z.literal("requested"),
				zod.z.literal("completed"),
				zod.z.literal("failed")
			]).readonly(),
			"error": zod.z.union([zod.z.literal(null), zod.z.string()]).readonly(),
			"errorCode": zod.z.union([zod.z.literal(null), zod.z.string()]).readonly(),
			"requestedAt": zod.z.union([zod.z.literal(null), zod.z.number()]).readonly(),
			"settledAt": zod.z.union([zod.z.literal(null), zod.z.number()]).readonly()
		});
		let _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02Create_parameter_0$schema$value;
		const _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02Create_parameter_0$schema = () => _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02Create_parameter_0$schema$value ??= zod.z.object({
			"displayName": zod.z.string(),
			"image": zod.z.string(),
			"limits": zod.z.object({
				"cpuMillis": zod.z.number(),
				"memoryBytes": zod.z.number(),
				"diskBytes": zod.z.union([zod.z.literal(null), zod.z.number()])
			}),
			"internetAccess": zod.z.boolean(),
			"mounts": zod.z.array(zod.z.object({
				"hostPath": zod.z.string(),
				"guestPath": zod.z.string(),
				"access": zod.z.union([zod.z.literal("read-only"), zod.z.literal("read-write")])
			}))
		});
		let _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02Create_parameter_1$schema$value;
		const _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02Create_parameter_1$schema = () => _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02Create_parameter_1$schema$value ??= zod.z.string();
		let _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02Create_result$schema$value;
		const _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02Create_result$schema = () => _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02Create_result$schema$value ??= zod.z.object({
			"id": zod.z.string().readonly(),
			"environmentId": zod.z.string().readonly(),
			"kind": zod.z.string().readonly(),
			"state": zod.z.union([
				zod.z.literal("running"),
				zod.z.literal("requested"),
				zod.z.literal("completed"),
				zod.z.literal("failed")
			]).readonly(),
			"error": zod.z.union([zod.z.literal(null), zod.z.string()]).readonly(),
			"errorCode": zod.z.union([zod.z.literal(null), zod.z.string()]).readonly(),
			"requestedAt": zod.z.union([zod.z.literal(null), zod.z.number()]).readonly(),
			"settledAt": zod.z.union([zod.z.literal(null), zod.z.number()]).readonly()
		});
		let _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02Pause_parameter_0$schema$value;
		const _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02Pause_parameter_0$schema = () => _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02Pause_parameter_0$schema$value ??= zod.z.string();
		let _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02Pause_parameter_1$schema$value;
		const _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02Pause_parameter_1$schema = () => _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02Pause_parameter_1$schema$value ??= zod.z.string();
		let _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02Pause_result$schema$value;
		const _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02Pause_result$schema = () => _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02Pause_result$schema$value ??= zod.z.object({
			"id": zod.z.string().readonly(),
			"environmentId": zod.z.string().readonly(),
			"kind": zod.z.string().readonly(),
			"state": zod.z.union([
				zod.z.literal("running"),
				zod.z.literal("requested"),
				zod.z.literal("completed"),
				zod.z.literal("failed")
			]).readonly(),
			"error": zod.z.union([zod.z.literal(null), zod.z.string()]).readonly(),
			"errorCode": zod.z.union([zod.z.literal(null), zod.z.string()]).readonly(),
			"requestedAt": zod.z.union([zod.z.literal(null), zod.z.number()]).readonly(),
			"settledAt": zod.z.union([zod.z.literal(null), zod.z.number()]).readonly()
		});
		let _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02PreviewRemoval_parameter_0$schema$value;
		const _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02PreviewRemoval_parameter_0$schema = () => _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02PreviewRemoval_parameter_0$schema$value ??= zod.z.string();
		let _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02PreviewRemoval_parameter_1$schema$value;
		const _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02PreviewRemoval_parameter_1$schema = () => _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02PreviewRemoval_parameter_1$schema$value ??= zod.z.boolean();
		let _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02PreviewRemoval_result$schema$value;
		const _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02PreviewRemoval_result$schema = () => _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02PreviewRemoval_result$schema$value ??= zod.z.object({
			"environmentId": zod.z.string(),
			"containerId": zod.z.string(),
			"volumeName": zod.z.string(),
			"networkName": zod.z.string(),
			"displayName": zod.z.union([zod.z.literal(null), zod.z.string()]),
			"hostMounts": zod.z.array(zod.z.string()),
			"deleteVolumes": zod.z.boolean(),
			"confirmToken": zod.z.string(),
			"expiresAt": zod.z.number()
		});
		let _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02Resume_parameter_0$schema$value;
		const _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02Resume_parameter_0$schema = () => _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02Resume_parameter_0$schema$value ??= zod.z.string();
		let _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02Resume_parameter_1$schema$value;
		const _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02Resume_parameter_1$schema = () => _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02Resume_parameter_1$schema$value ??= zod.z.string();
		let _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02Resume_result$schema$value;
		const _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02Resume_result$schema = () => _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02Resume_result$schema$value ??= zod.z.object({
			"id": zod.z.string().readonly(),
			"environmentId": zod.z.string().readonly(),
			"kind": zod.z.string().readonly(),
			"state": zod.z.union([
				zod.z.literal("running"),
				zod.z.literal("requested"),
				zod.z.literal("completed"),
				zod.z.literal("failed")
			]).readonly(),
			"error": zod.z.union([zod.z.literal(null), zod.z.string()]).readonly(),
			"errorCode": zod.z.union([zod.z.literal(null), zod.z.string()]).readonly(),
			"requestedAt": zod.z.union([zod.z.literal(null), zod.z.number()]).readonly(),
			"settledAt": zod.z.union([zod.z.literal(null), zod.z.number()]).readonly()
		});
		let _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02Snapshot_parameter_0$schema$value;
		const _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02Snapshot_parameter_0$schema = () => _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02Snapshot_parameter_0$schema$value ??= zod.z.union([zod.z.literal(null), zod.z.string()]);
		let _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02Snapshot_result$schema$value;
		const _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02Snapshot_result$schema = () => _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02Snapshot_result$schema$value ??= zod.z.object({
			"environments": zod.z.array(zod.z.object({
				"id": zod.z.string().readonly(),
				"displayName": zod.z.string().readonly(),
				"backend": zod.z.literal("docker").readonly(),
				"ownership": zod.z.union([zod.z.literal("plugin"), zod.z.literal("imported")]).readonly(),
				"image": zod.z.string().readonly(),
				"digest": zod.z.string().readonly(),
				"createdAt": zod.z.number().readonly(),
				"mounts": zod.z.array(zod.z.object({
					"hostPath": zod.z.string().readonly(),
					"guestPath": zod.z.string().readonly(),
					"access": zod.z.union([zod.z.literal("read-only"), zod.z.literal("read-write")]).readonly()
				})).readonly(),
				"limits": zod.z.object({
					"cpuMillis": zod.z.number().readonly(),
					"memoryBytes": zod.z.number().readonly(),
					"diskBytes": zod.z.union([zod.z.literal(null), zod.z.number()]).readonly()
				}).readonly(),
				"internetAccess": zod.z.boolean().readonly(),
				"desiredPhase": zod.z.union([
					zod.z.literal(null),
					zod.z.literal("running"),
					zod.z.literal("stopped"),
					zod.z.literal("paused")
				]).readonly(),
				"observed": zod.z.union([zod.z.literal(null), zod.z.object({
					"phase": zod.z.union([
						zod.z.literal("running"),
						zod.z.literal("stopped"),
						zod.z.literal("paused"),
						zod.z.literal("missing"),
						zod.z.literal("created"),
						zod.z.literal("error")
					]).readonly(),
					"shell": zod.z.union([zod.z.object({
						"kind": zod.z.union([zod.z.literal("available"), zod.z.literal("unavailable")]).readonly(),
						"reason": zod.z.literal(null).readonly()
					}), zod.z.object({
						"kind": zod.z.literal("unknown").readonly(),
						"reason": zod.z.string().readonly()
					})]).readonly(),
					"browser": zod.z.union([zod.z.object({
						"kind": zod.z.union([zod.z.literal("available"), zod.z.literal("unavailable")]).readonly(),
						"reason": zod.z.literal(null).readonly()
					}), zod.z.object({
						"kind": zod.z.literal("unknown").readonly(),
						"reason": zod.z.string().readonly()
					})]).readonly(),
					"desktop": zod.z.union([zod.z.object({
						"kind": zod.z.union([zod.z.literal("available"), zod.z.literal("unavailable")]).readonly(),
						"reason": zod.z.literal(null).readonly()
					}), zod.z.object({
						"kind": zod.z.literal("unknown").readonly(),
						"reason": zod.z.string().readonly()
					})]).readonly(),
					"hostControlPlane": zod.z.union([zod.z.object({
						"kind": zod.z.union([zod.z.literal("available"), zod.z.literal("unavailable")]).readonly(),
						"reason": zod.z.literal(null).readonly()
					}), zod.z.object({
						"kind": zod.z.literal("unknown").readonly(),
						"reason": zod.z.string().readonly()
					})]).readonly(),
					"observedAt": zod.z.union([zod.z.literal(null), zod.z.number()]).readonly()
				})]).readonly(),
				"resources": zod.z.union([zod.z.literal(null), zod.z.object({
					"takenAt": zod.z.number().readonly(),
					"stale": zod.z.boolean().readonly(),
					"cpuPercent": zod.z.union([zod.z.literal(null), zod.z.number()]).readonly(),
					"memoryUsedBytes": zod.z.union([zod.z.literal(null), zod.z.number()]).readonly(),
					"memoryLimitBytes": zod.z.union([zod.z.literal(null), zod.z.number()]).readonly(),
					"writableLayerBytes": zod.z.union([zod.z.literal(null), zod.z.number()]).readonly(),
					"volumeUsedBytes": zod.z.union([zod.z.literal(null), zod.z.number()]).readonly()
				})]).readonly(),
				"bindings": zod.z.array(zod.z.object({
					"sessionKey": zod.z.string().readonly(),
					"environmentId": zod.z.string().readonly(),
					"generation": zod.z.number().readonly(),
					"history": zod.z.array(zod.z.string()).readonly()
				})).readonly(),
				"bindingsComplete": zod.z.boolean().readonly(),
				"operations": zod.z.array(zod.z.object({
					"id": zod.z.string().readonly(),
					"environmentId": zod.z.string().readonly(),
					"kind": zod.z.string().readonly(),
					"state": zod.z.union([
						zod.z.literal("running"),
						zod.z.literal("requested"),
						zod.z.literal("completed"),
						zod.z.literal("failed")
					]).readonly(),
					"error": zod.z.union([zod.z.literal(null), zod.z.string()]).readonly(),
					"errorCode": zod.z.union([zod.z.literal(null), zod.z.string()]).readonly(),
					"requestedAt": zod.z.union([zod.z.literal(null), zod.z.number()]).readonly(),
					"settledAt": zod.z.union([zod.z.literal(null), zod.z.number()]).readonly()
				})).readonly(),
				"uncertainty": zod.z.union([zod.z.literal(null), zod.z.string()]).readonly()
			})).readonly(),
			"policy": zod.z.union([zod.z.literal(null), zod.z.object({
				"sessionKey": zod.z.string().readonly(),
				"mode": zod.z.union([
					zod.z.literal("normal"),
					zod.z.literal("activating"),
					zod.z.literal("protected"),
					zod.z.literal("protected-unavailable")
				]).readonly(),
				"generation": zod.z.number().readonly(),
				"stage": zod.z.string().readonly(),
				"environmentId": zod.z.union([zod.z.literal(null), zod.z.string()]).readonly(),
				"reason": zod.z.union([zod.z.literal(null), zod.z.string()]).readonly()
			})]).readonly(),
			"binding": zod.z.union([zod.z.literal(null), zod.z.object({
				"sessionKey": zod.z.string().readonly(),
				"environmentId": zod.z.string().readonly(),
				"generation": zod.z.number().readonly(),
				"history": zod.z.array(zod.z.string()).readonly()
			})]).readonly(),
			"bindingComplete": zod.z.boolean().readonly()
		});
		let _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02Start_parameter_0$schema$value;
		const _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02Start_parameter_0$schema = () => _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02Start_parameter_0$schema$value ??= zod.z.string();
		let _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02Start_parameter_1$schema$value;
		const _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02Start_parameter_1$schema = () => _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02Start_parameter_1$schema$value ??= zod.z.string();
		let _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02Start_result$schema$value;
		const _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02Start_result$schema = () => _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02Start_result$schema$value ??= zod.z.object({
			"id": zod.z.string().readonly(),
			"environmentId": zod.z.string().readonly(),
			"kind": zod.z.string().readonly(),
			"state": zod.z.union([
				zod.z.literal("running"),
				zod.z.literal("requested"),
				zod.z.literal("completed"),
				zod.z.literal("failed")
			]).readonly(),
			"error": zod.z.union([zod.z.literal(null), zod.z.string()]).readonly(),
			"errorCode": zod.z.union([zod.z.literal(null), zod.z.string()]).readonly(),
			"requestedAt": zod.z.union([zod.z.literal(null), zod.z.number()]).readonly(),
			"settledAt": zod.z.union([zod.z.literal(null), zod.z.number()]).readonly()
		});
		let _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02Stop_parameter_0$schema$value;
		const _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02Stop_parameter_0$schema = () => _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02Stop_parameter_0$schema$value ??= zod.z.string();
		let _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02Stop_parameter_1$schema$value;
		const _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02Stop_parameter_1$schema = () => _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02Stop_parameter_1$schema$value ??= zod.z.string();
		let _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02Stop_result$schema$value;
		const _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02Stop_result$schema = () => _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02Stop_result$schema$value ??= zod.z.object({
			"id": zod.z.string().readonly(),
			"environmentId": zod.z.string().readonly(),
			"kind": zod.z.string().readonly(),
			"state": zod.z.union([
				zod.z.literal("running"),
				zod.z.literal("requested"),
				zod.z.literal("completed"),
				zod.z.literal("failed")
			]).readonly(),
			"error": zod.z.union([zod.z.literal(null), zod.z.string()]).readonly(),
			"errorCode": zod.z.union([zod.z.literal(null), zod.z.string()]).readonly(),
			"requestedAt": zod.z.union([zod.z.literal(null), zod.z.number()]).readonly(),
			"settledAt": zod.z.union([zod.z.literal(null), zod.z.number()]).readonly()
		});
		let _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02Unbind_parameter_0$schema$value;
		const _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02Unbind_parameter_0$schema = () => _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02Unbind_parameter_0$schema$value ??= zod.z.string();
		let _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02Unbind_parameter_1$schema$value;
		const _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02Unbind_parameter_1$schema = () => _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02Unbind_parameter_1$schema$value ??= zod.z.string();
		let _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02Unbind_result$schema$value;
		const _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02Unbind_result$schema = () => _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02Unbind_result$schema$value ??= zod.z.object({
			"id": zod.z.string().readonly(),
			"environmentId": zod.z.string().readonly(),
			"kind": zod.z.string().readonly(),
			"state": zod.z.union([
				zod.z.literal("running"),
				zod.z.literal("requested"),
				zod.z.literal("completed"),
				zod.z.literal("failed")
			]).readonly(),
			"error": zod.z.union([zod.z.literal(null), zod.z.string()]).readonly(),
			"errorCode": zod.z.union([zod.z.literal(null), zod.z.string()]).readonly(),
			"requestedAt": zod.z.union([zod.z.literal(null), zod.z.number()]).readonly(),
			"settledAt": zod.z.union([zod.z.literal(null), zod.z.number()]).readonly()
		});
		let _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02UpdateLimits_parameter_0$schema$value;
		const _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02UpdateLimits_parameter_0$schema = () => _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02UpdateLimits_parameter_0$schema$value ??= zod.z.string();
		let _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02UpdateLimits_parameter_1$schema$value;
		const _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02UpdateLimits_parameter_1$schema = () => _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02UpdateLimits_parameter_1$schema$value ??= zod.z.object({
			"cpuMillis": zod.z.number(),
			"memoryBytes": zod.z.number(),
			"diskBytes": zod.z.union([zod.z.literal(null), zod.z.number()])
		});
		let _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02UpdateLimits_parameter_2$schema$value;
		const _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02UpdateLimits_parameter_2$schema = () => _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02UpdateLimits_parameter_2$schema$value ??= zod.z.string();
		let _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02UpdateLimits_result$schema$value;
		const _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02UpdateLimits_result$schema = () => _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02UpdateLimits_result$schema$value ??= zod.z.object({
			"id": zod.z.string().readonly(),
			"environmentId": zod.z.string().readonly(),
			"kind": zod.z.string().readonly(),
			"state": zod.z.union([
				zod.z.literal("running"),
				zod.z.literal("requested"),
				zod.z.literal("completed"),
				zod.z.literal("failed")
			]).readonly(),
			"error": zod.z.union([zod.z.literal(null), zod.z.string()]).readonly(),
			"errorCode": zod.z.union([zod.z.literal(null), zod.z.string()]).readonly(),
			"requestedAt": zod.z.union([zod.z.literal(null), zod.z.number()]).readonly(),
			"settledAt": zod.z.union([zod.z.literal(null), zod.z.number()]).readonly()
		});
		let _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02ViewerUrl_parameter_0$schema$value;
		const _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02ViewerUrl_parameter_0$schema = () => _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02ViewerUrl_parameter_0$schema$value ??= zod.z.string();
		let _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02ViewerUrl_parameter_1$schema$value;
		const _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02ViewerUrl_parameter_1$schema = () => _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02ViewerUrl_parameter_1$schema$value ??= zod.z.string();
		let _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02ViewerUrl_parameter_2$schema$value;
		const _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02ViewerUrl_parameter_2$schema = () => _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02ViewerUrl_parameter_2$schema$value ??= zod.z.number();
		let _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02ViewerUrl_result$schema$value;
		const _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02ViewerUrl_result$schema = () => _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02ViewerUrl_result$schema$value ??= zod.z.union([zod.z.literal(null), zod.z.object({
			"url": zod.z.string().readonly(),
			"expiresAt": zod.z.union([zod.z.literal(null), zod.z.number()]).readonly(),
			"epoch": zod.z.string().readonly(),
			"revision": zod.z.number().readonly()
		})]);
		let _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02WatchResources_parameter_0$schema$value;
		const _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02WatchResources_parameter_0$schema = () => _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02WatchResources_parameter_0$schema$value ??= zod.z.array(zod.z.string());
		let _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02WatchResources_result$schema$value;
		const _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02WatchResources_result$schema = () => _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02WatchResources_result$schema$value ??= zod.z.object({
			"environmentId": zod.z.string().readonly(),
			"resources": zod.z.object({
				"takenAt": zod.z.number().readonly(),
				"stale": zod.z.boolean().readonly(),
				"cpuPercent": zod.z.union([zod.z.literal(null), zod.z.number()]).readonly(),
				"memoryUsedBytes": zod.z.union([zod.z.literal(null), zod.z.number()]).readonly(),
				"memoryLimitBytes": zod.z.union([zod.z.literal(null), zod.z.number()]).readonly(),
				"writableLayerBytes": zod.z.union([zod.z.literal(null), zod.z.number()]).readonly(),
				"volumeUsedBytes": zod.z.union([zod.z.literal(null), zod.z.number()]).readonly()
			}).readonly()
		});
		let _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02WatchSession_parameter_0$schema$value;
		const _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02WatchSession_parameter_0$schema = () => _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02WatchSession_parameter_0$schema$value ??= zod.z.string();
		let _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02WatchSession_result$schema$value;
		const _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02WatchSession_result$schema = () => _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02WatchSession_result$schema$value ??= zod.z.object({
			"epoch": zod.z.string().readonly(),
			"revision": zod.z.number().readonly(),
			"policy": zod.z.object({
				"sessionKey": zod.z.string().readonly(),
				"mode": zod.z.union([
					zod.z.literal("normal"),
					zod.z.literal("activating"),
					zod.z.literal("protected"),
					zod.z.literal("protected-unavailable")
				]).readonly(),
				"generation": zod.z.number().readonly(),
				"stage": zod.z.string().readonly(),
				"environmentId": zod.z.union([zod.z.literal(null), zod.z.string()]).readonly(),
				"reason": zod.z.union([zod.z.literal(null), zod.z.string()]).readonly()
			}).readonly(),
			"binding": zod.z.union([zod.z.literal(null), zod.z.object({
				"sessionKey": zod.z.string().readonly(),
				"environmentId": zod.z.string().readonly(),
				"generation": zod.z.number().readonly(),
				"history": zod.z.array(zod.z.string()).readonly()
			})]).readonly(),
			"bindingComplete": zod.z.boolean().readonly()
		});
		let _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02Bind_parameter_0_strict$schema$value;
		const _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02Bind_parameter_0_strict$schema = () => _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02Bind_parameter_0_strict$schema$value ??= zod.z.string();
		let _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02Bind_parameter_1_strict$schema$value;
		const _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02Bind_parameter_1_strict$schema = () => _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02Bind_parameter_1_strict$schema$value ??= zod.z.string();
		let _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02Bind_parameter_2_strict$schema$value;
		const _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02Bind_parameter_2_strict$schema = () => _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02Bind_parameter_2_strict$schema$value ??= zod.z.string();
		let _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02ConfirmRemoval_parameter_0_strict$schema$value;
		const _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02ConfirmRemoval_parameter_0_strict$schema = () => _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02ConfirmRemoval_parameter_0_strict$schema$value ??= zod.z.string();
		let _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02ConfirmRemoval_parameter_1_strict$schema$value;
		const _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02ConfirmRemoval_parameter_1_strict$schema = () => _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02ConfirmRemoval_parameter_1_strict$schema$value ??= zod.z.string();
		let _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02ConfirmRemoval_parameter_2_strict$schema$value;
		const _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02ConfirmRemoval_parameter_2_strict$schema = () => _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02ConfirmRemoval_parameter_2_strict$schema$value ??= zod.z.boolean();
		let _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02ConfirmRemoval_parameter_3_strict$schema$value;
		const _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02ConfirmRemoval_parameter_3_strict$schema = () => _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02ConfirmRemoval_parameter_3_strict$schema$value ??= zod.z.string();
		let _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02Create_parameter_0_strict$schema$value;
		const _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02Create_parameter_0_strict$schema = () => _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02Create_parameter_0_strict$schema$value ??= zod.z.strictObject({
			"displayName": zod.z.string(),
			"image": zod.z.string(),
			"limits": zod.z.strictObject({
				"cpuMillis": zod.z.number(),
				"memoryBytes": zod.z.number(),
				"diskBytes": zod.z.union([zod.z.literal(null), zod.z.number()])
			}),
			"internetAccess": zod.z.boolean(),
			"mounts": zod.z.array(zod.z.strictObject({
				"hostPath": zod.z.string(),
				"guestPath": zod.z.string(),
				"access": zod.z.union([zod.z.literal("read-only"), zod.z.literal("read-write")])
			}))
		});
		let _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02Create_parameter_1_strict$schema$value;
		const _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02Create_parameter_1_strict$schema = () => _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02Create_parameter_1_strict$schema$value ??= zod.z.string();
		let _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02Pause_parameter_0_strict$schema$value;
		const _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02Pause_parameter_0_strict$schema = () => _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02Pause_parameter_0_strict$schema$value ??= zod.z.string();
		let _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02Pause_parameter_1_strict$schema$value;
		const _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02Pause_parameter_1_strict$schema = () => _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02Pause_parameter_1_strict$schema$value ??= zod.z.string();
		let _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02PreviewRemoval_parameter_0_strict$schema$value;
		const _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02PreviewRemoval_parameter_0_strict$schema = () => _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02PreviewRemoval_parameter_0_strict$schema$value ??= zod.z.string();
		let _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02PreviewRemoval_parameter_1_strict$schema$value;
		const _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02PreviewRemoval_parameter_1_strict$schema = () => _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02PreviewRemoval_parameter_1_strict$schema$value ??= zod.z.boolean();
		let _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02Resume_parameter_0_strict$schema$value;
		const _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02Resume_parameter_0_strict$schema = () => _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02Resume_parameter_0_strict$schema$value ??= zod.z.string();
		let _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02Resume_parameter_1_strict$schema$value;
		const _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02Resume_parameter_1_strict$schema = () => _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02Resume_parameter_1_strict$schema$value ??= zod.z.string();
		let _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02Snapshot_parameter_0_strict$schema$value;
		const _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02Snapshot_parameter_0_strict$schema = () => _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02Snapshot_parameter_0_strict$schema$value ??= zod.z.union([zod.z.literal(null), zod.z.string()]);
		let _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02Start_parameter_0_strict$schema$value;
		const _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02Start_parameter_0_strict$schema = () => _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02Start_parameter_0_strict$schema$value ??= zod.z.string();
		let _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02Start_parameter_1_strict$schema$value;
		const _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02Start_parameter_1_strict$schema = () => _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02Start_parameter_1_strict$schema$value ??= zod.z.string();
		let _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02Stop_parameter_0_strict$schema$value;
		const _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02Stop_parameter_0_strict$schema = () => _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02Stop_parameter_0_strict$schema$value ??= zod.z.string();
		let _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02Stop_parameter_1_strict$schema$value;
		const _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02Stop_parameter_1_strict$schema = () => _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02Stop_parameter_1_strict$schema$value ??= zod.z.string();
		let _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02Unbind_parameter_0_strict$schema$value;
		const _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02Unbind_parameter_0_strict$schema = () => _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02Unbind_parameter_0_strict$schema$value ??= zod.z.string();
		let _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02Unbind_parameter_1_strict$schema$value;
		const _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02Unbind_parameter_1_strict$schema = () => _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02Unbind_parameter_1_strict$schema$value ??= zod.z.string();
		let _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02UpdateLimits_parameter_0_strict$schema$value;
		const _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02UpdateLimits_parameter_0_strict$schema = () => _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02UpdateLimits_parameter_0_strict$schema$value ??= zod.z.string();
		let _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02UpdateLimits_parameter_1_strict$schema$value;
		const _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02UpdateLimits_parameter_1_strict$schema = () => _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02UpdateLimits_parameter_1_strict$schema$value ??= zod.z.strictObject({
			"cpuMillis": zod.z.number(),
			"memoryBytes": zod.z.number(),
			"diskBytes": zod.z.union([zod.z.literal(null), zod.z.number()])
		});
		let _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02UpdateLimits_parameter_2_strict$schema$value;
		const _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02UpdateLimits_parameter_2_strict$schema = () => _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02UpdateLimits_parameter_2_strict$schema$value ??= zod.z.string();
		let _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02ViewerUrl_parameter_0_strict$schema$value;
		const _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02ViewerUrl_parameter_0_strict$schema = () => _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02ViewerUrl_parameter_0_strict$schema$value ??= zod.z.string();
		let _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02ViewerUrl_parameter_1_strict$schema$value;
		const _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02ViewerUrl_parameter_1_strict$schema = () => _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02ViewerUrl_parameter_1_strict$schema$value ??= zod.z.string();
		let _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02ViewerUrl_parameter_2_strict$schema$value;
		const _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02ViewerUrl_parameter_2_strict$schema = () => _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02ViewerUrl_parameter_2_strict$schema$value ??= zod.z.number();
		let _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02WatchResources_parameter_0_strict$schema$value;
		const _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02WatchResources_parameter_0_strict$schema = () => _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02WatchResources_parameter_0_strict$schema$value ??= zod.z.array(zod.z.string());
		let _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02WatchSession_parameter_0_strict$schema$value;
		const _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02WatchSession_parameter_0_strict$schema = () => _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02WatchSession_parameter_0_strict$schema$value ??= zod.z.string();
		const TYPERT_REMOTE = createTypertRemoteInfo({
			package: "@deepseek-ai/dsh-wrapvm-isolate",
			methods: {
				"wrapvmIsolate/v02Bind": {
					service: "wrapvmIsolate",
					invocation: { kind: "direct" },
					parameters: [
						{
							name: "session",
							source: "json",
							codec: {
								mode: "strict",
								typeSymbol: "@deepseek-ai/dsh-wrapvm-isolate#wrapvmIsolate/v02Bind:session",
								create: _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02Bind_parameter_0$schema,
								jsonSchema: { "type": "string" }
							},
							strictCodec: {
								mode: "strict",
								typeSymbol: "@deepseek-ai/dsh-wrapvm-isolate#wrapvmIsolate/v02Bind:session",
								create: _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02Bind_parameter_0_strict$schema,
								jsonSchema: { "type": "string" }
							}
						},
						{
							name: "id",
							source: "json",
							codec: {
								mode: "strict",
								typeSymbol: "@deepseek-ai/dsh-wrapvm-isolate#wrapvmIsolate/v02Bind:id",
								create: _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02Bind_parameter_1$schema,
								jsonSchema: { "type": "string" }
							},
							strictCodec: {
								mode: "strict",
								typeSymbol: "@deepseek-ai/dsh-wrapvm-isolate#wrapvmIsolate/v02Bind:id",
								create: _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02Bind_parameter_1_strict$schema,
								jsonSchema: { "type": "string" }
							}
						},
						{
							name: "_key",
							source: "json",
							codec: {
								mode: "strict",
								typeSymbol: "@deepseek-ai/dsh-wrapvm-isolate#wrapvmIsolate/v02Bind:_key",
								create: _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02Bind_parameter_2$schema,
								jsonSchema: { "type": "string" }
							},
							strictCodec: {
								mode: "strict",
								typeSymbol: "@deepseek-ai/dsh-wrapvm-isolate#wrapvmIsolate/v02Bind:_key",
								create: _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02Bind_parameter_2_strict$schema,
								jsonSchema: { "type": "string" }
							}
						}
					],
					result: {
						mode: "strict",
						typeSymbol: "@deepseek-ai/dsh-wrapvm-isolate/types#VmOperationView",
						create: _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02Bind_result$schema,
						jsonSchema: {
							"type": "object",
							"properties": {
								"id": { "type": "string" },
								"environmentId": { "type": "string" },
								"kind": { "type": "string" },
								"state": {
									"type": "string",
									"enum": [
										"running",
										"requested",
										"completed",
										"failed"
									]
								},
								"error": { "oneOf": [{
									"type": "null",
									"const": null
								}, { "type": "string" }] },
								"errorCode": { "oneOf": [{
									"type": "null",
									"const": null
								}, { "type": "string" }] },
								"requestedAt": { "oneOf": [{
									"type": "null",
									"const": null
								}, { "type": "number" }] },
								"settledAt": { "oneOf": [{
									"type": "null",
									"const": null
								}, { "type": "number" }] }
							},
							"required": [
								"id",
								"environmentId",
								"kind",
								"state",
								"error",
								"errorCode",
								"requestedAt",
								"settledAt"
							],
							"additionalProperties": true
						}
					},
					sourceLocation: {
						"file": "packages/bundle/wrapvm-isolate/src/index.ts",
						"line": 342,
						"column": 9
					}
				},
				"wrapvmIsolate/v02ConfirmRemoval": {
					service: "wrapvmIsolate",
					invocation: { kind: "direct" },
					parameters: [
						{
							name: "id",
							source: "json",
							codec: {
								mode: "strict",
								typeSymbol: "@deepseek-ai/dsh-wrapvm-isolate#wrapvmIsolate/v02ConfirmRemoval:id",
								create: _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02ConfirmRemoval_parameter_0$schema,
								jsonSchema: { "type": "string" }
							},
							strictCodec: {
								mode: "strict",
								typeSymbol: "@deepseek-ai/dsh-wrapvm-isolate#wrapvmIsolate/v02ConfirmRemoval:id",
								create: _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02ConfirmRemoval_parameter_0_strict$schema,
								jsonSchema: { "type": "string" }
							}
						},
						{
							name: "token",
							source: "json",
							codec: {
								mode: "strict",
								typeSymbol: "@deepseek-ai/dsh-wrapvm-isolate#wrapvmIsolate/v02ConfirmRemoval:token",
								create: _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02ConfirmRemoval_parameter_1$schema,
								jsonSchema: { "type": "string" }
							},
							strictCodec: {
								mode: "strict",
								typeSymbol: "@deepseek-ai/dsh-wrapvm-isolate#wrapvmIsolate/v02ConfirmRemoval:token",
								create: _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02ConfirmRemoval_parameter_1_strict$schema,
								jsonSchema: { "type": "string" }
							}
						},
						{
							name: "deleteVolumes",
							source: "json",
							codec: {
								mode: "strict",
								typeSymbol: "@deepseek-ai/dsh-wrapvm-isolate#wrapvmIsolate/v02ConfirmRemoval:deleteVolumes",
								create: _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02ConfirmRemoval_parameter_2$schema,
								jsonSchema: { "type": "boolean" }
							},
							strictCodec: {
								mode: "strict",
								typeSymbol: "@deepseek-ai/dsh-wrapvm-isolate#wrapvmIsolate/v02ConfirmRemoval:deleteVolumes",
								create: _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02ConfirmRemoval_parameter_2_strict$schema,
								jsonSchema: { "type": "boolean" }
							}
						},
						{
							name: "key",
							source: "json",
							codec: {
								mode: "strict",
								typeSymbol: "@deepseek-ai/dsh-wrapvm-isolate#wrapvmIsolate/v02ConfirmRemoval:key",
								create: _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02ConfirmRemoval_parameter_3$schema,
								jsonSchema: { "type": "string" }
							},
							strictCodec: {
								mode: "strict",
								typeSymbol: "@deepseek-ai/dsh-wrapvm-isolate#wrapvmIsolate/v02ConfirmRemoval:key",
								create: _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02ConfirmRemoval_parameter_3_strict$schema,
								jsonSchema: { "type": "string" }
							}
						}
					],
					result: {
						mode: "strict",
						typeSymbol: "@deepseek-ai/dsh-wrapvm-isolate/types#VmOperationView",
						create: _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02ConfirmRemoval_result$schema,
						jsonSchema: {
							"type": "object",
							"properties": {
								"id": { "type": "string" },
								"environmentId": { "type": "string" },
								"kind": { "type": "string" },
								"state": {
									"type": "string",
									"enum": [
										"running",
										"requested",
										"completed",
										"failed"
									]
								},
								"error": { "oneOf": [{
									"type": "null",
									"const": null
								}, { "type": "string" }] },
								"errorCode": { "oneOf": [{
									"type": "null",
									"const": null
								}, { "type": "string" }] },
								"requestedAt": { "oneOf": [{
									"type": "null",
									"const": null
								}, { "type": "number" }] },
								"settledAt": { "oneOf": [{
									"type": "null",
									"const": null
								}, { "type": "number" }] }
							},
							"required": [
								"id",
								"environmentId",
								"kind",
								"state",
								"error",
								"errorCode",
								"requestedAt",
								"settledAt"
							],
							"additionalProperties": true
						}
					},
					sourceLocation: {
						"file": "packages/bundle/wrapvm-isolate/src/index.ts",
						"line": 340,
						"column": 9
					}
				},
				"wrapvmIsolate/v02Create": {
					service: "wrapvmIsolate",
					invocation: { kind: "direct" },
					parameters: [{
						name: "input",
						source: "json",
						codec: {
							mode: "strict",
							typeSymbol: "@deepseek-ai/dsh-wrapvm-isolate#wrapvmIsolate/v02Create:input",
							create: _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02Create_parameter_0$schema,
							jsonSchema: {
								"type": "object",
								"properties": {
									"displayName": { "type": "string" },
									"image": { "type": "string" },
									"limits": {
										"type": "object",
										"properties": {
											"cpuMillis": { "type": "number" },
											"memoryBytes": { "type": "number" },
											"diskBytes": { "oneOf": [{
												"type": "null",
												"const": null
											}, { "type": "number" }] }
										},
										"required": [
											"cpuMillis",
											"memoryBytes",
											"diskBytes"
										],
										"additionalProperties": true
									},
									"internetAccess": { "type": "boolean" },
									"mounts": {
										"type": "array",
										"items": {
											"type": "object",
											"properties": {
												"hostPath": { "type": "string" },
												"guestPath": { "type": "string" },
												"access": {
													"type": "string",
													"enum": ["read-only", "read-write"]
												}
											},
											"required": [
												"hostPath",
												"guestPath",
												"access"
											],
											"additionalProperties": true
										}
									}
								},
								"required": [
									"displayName",
									"image",
									"limits",
									"internetAccess",
									"mounts"
								],
								"additionalProperties": true
							}
						},
						strictCodec: {
							mode: "strict",
							typeSymbol: "@deepseek-ai/dsh-wrapvm-isolate#wrapvmIsolate/v02Create:input",
							create: _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02Create_parameter_0_strict$schema,
							jsonSchema: {
								"type": "object",
								"properties": {
									"displayName": { "type": "string" },
									"image": { "type": "string" },
									"limits": {
										"type": "object",
										"properties": {
											"cpuMillis": { "type": "number" },
											"memoryBytes": { "type": "number" },
											"diskBytes": { "oneOf": [{
												"type": "null",
												"const": null
											}, { "type": "number" }] }
										},
										"required": [
											"cpuMillis",
											"memoryBytes",
											"diskBytes"
										],
										"additionalProperties": false
									},
									"internetAccess": { "type": "boolean" },
									"mounts": {
										"type": "array",
										"items": {
											"type": "object",
											"properties": {
												"hostPath": { "type": "string" },
												"guestPath": { "type": "string" },
												"access": {
													"type": "string",
													"enum": ["read-only", "read-write"]
												}
											},
											"required": [
												"hostPath",
												"guestPath",
												"access"
											],
											"additionalProperties": false
										}
									}
								},
								"required": [
									"displayName",
									"image",
									"limits",
									"internetAccess",
									"mounts"
								],
								"additionalProperties": false
							}
						}
					}, {
						name: "key",
						source: "json",
						codec: {
							mode: "strict",
							typeSymbol: "@deepseek-ai/dsh-wrapvm-isolate#wrapvmIsolate/v02Create:key",
							create: _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02Create_parameter_1$schema,
							jsonSchema: { "type": "string" }
						},
						strictCodec: {
							mode: "strict",
							typeSymbol: "@deepseek-ai/dsh-wrapvm-isolate#wrapvmIsolate/v02Create:key",
							create: _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02Create_parameter_1_strict$schema,
							jsonSchema: { "type": "string" }
						}
					}],
					result: {
						mode: "strict",
						typeSymbol: "@deepseek-ai/dsh-wrapvm-isolate/types#VmOperationView",
						create: _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02Create_result$schema,
						jsonSchema: {
							"type": "object",
							"properties": {
								"id": { "type": "string" },
								"environmentId": { "type": "string" },
								"kind": { "type": "string" },
								"state": {
									"type": "string",
									"enum": [
										"running",
										"requested",
										"completed",
										"failed"
									]
								},
								"error": { "oneOf": [{
									"type": "null",
									"const": null
								}, { "type": "string" }] },
								"errorCode": { "oneOf": [{
									"type": "null",
									"const": null
								}, { "type": "string" }] },
								"requestedAt": { "oneOf": [{
									"type": "null",
									"const": null
								}, { "type": "number" }] },
								"settledAt": { "oneOf": [{
									"type": "null",
									"const": null
								}, { "type": "number" }] }
							},
							"required": [
								"id",
								"environmentId",
								"kind",
								"state",
								"error",
								"errorCode",
								"requestedAt",
								"settledAt"
							],
							"additionalProperties": true
						}
					},
					sourceLocation: {
						"file": "packages/bundle/wrapvm-isolate/src/index.ts",
						"line": 311,
						"column": 9
					}
				},
				"wrapvmIsolate/v02Pause": {
					service: "wrapvmIsolate",
					invocation: { kind: "direct" },
					parameters: [{
						name: "id",
						source: "json",
						codec: {
							mode: "strict",
							typeSymbol: "@deepseek-ai/dsh-wrapvm-isolate#wrapvmIsolate/v02Pause:id",
							create: _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02Pause_parameter_0$schema,
							jsonSchema: { "type": "string" }
						},
						strictCodec: {
							mode: "strict",
							typeSymbol: "@deepseek-ai/dsh-wrapvm-isolate#wrapvmIsolate/v02Pause:id",
							create: _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02Pause_parameter_0_strict$schema,
							jsonSchema: { "type": "string" }
						}
					}, {
						name: "key",
						source: "json",
						codec: {
							mode: "strict",
							typeSymbol: "@deepseek-ai/dsh-wrapvm-isolate#wrapvmIsolate/v02Pause:key",
							create: _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02Pause_parameter_1$schema,
							jsonSchema: { "type": "string" }
						},
						strictCodec: {
							mode: "strict",
							typeSymbol: "@deepseek-ai/dsh-wrapvm-isolate#wrapvmIsolate/v02Pause:key",
							create: _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02Pause_parameter_1_strict$schema,
							jsonSchema: { "type": "string" }
						}
					}],
					result: {
						mode: "strict",
						typeSymbol: "@deepseek-ai/dsh-wrapvm-isolate/types#VmOperationView",
						create: _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02Pause_result$schema,
						jsonSchema: {
							"type": "object",
							"properties": {
								"id": { "type": "string" },
								"environmentId": { "type": "string" },
								"kind": { "type": "string" },
								"state": {
									"type": "string",
									"enum": [
										"running",
										"requested",
										"completed",
										"failed"
									]
								},
								"error": { "oneOf": [{
									"type": "null",
									"const": null
								}, { "type": "string" }] },
								"errorCode": { "oneOf": [{
									"type": "null",
									"const": null
								}, { "type": "string" }] },
								"requestedAt": { "oneOf": [{
									"type": "null",
									"const": null
								}, { "type": "number" }] },
								"settledAt": { "oneOf": [{
									"type": "null",
									"const": null
								}, { "type": "number" }] }
							},
							"required": [
								"id",
								"environmentId",
								"kind",
								"state",
								"error",
								"errorCode",
								"requestedAt",
								"settledAt"
							],
							"additionalProperties": true
						}
					},
					sourceLocation: {
						"file": "packages/bundle/wrapvm-isolate/src/index.ts",
						"line": 329,
						"column": 9
					}
				},
				"wrapvmIsolate/v02PreviewRemoval": {
					service: "wrapvmIsolate",
					invocation: { kind: "direct" },
					parameters: [{
						name: "id",
						source: "json",
						codec: {
							mode: "strict",
							typeSymbol: "@deepseek-ai/dsh-wrapvm-isolate#wrapvmIsolate/v02PreviewRemoval:id",
							create: _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02PreviewRemoval_parameter_0$schema,
							jsonSchema: { "type": "string" }
						},
						strictCodec: {
							mode: "strict",
							typeSymbol: "@deepseek-ai/dsh-wrapvm-isolate#wrapvmIsolate/v02PreviewRemoval:id",
							create: _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02PreviewRemoval_parameter_0_strict$schema,
							jsonSchema: { "type": "string" }
						}
					}, {
						name: "deleteVolumes",
						source: "json",
						codec: {
							mode: "strict",
							typeSymbol: "@deepseek-ai/dsh-wrapvm-isolate#wrapvmIsolate/v02PreviewRemoval:deleteVolumes",
							create: _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02PreviewRemoval_parameter_1$schema,
							jsonSchema: { "type": "boolean" }
						},
						strictCodec: {
							mode: "strict",
							typeSymbol: "@deepseek-ai/dsh-wrapvm-isolate#wrapvmIsolate/v02PreviewRemoval:deleteVolumes",
							create: _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02PreviewRemoval_parameter_1_strict$schema,
							jsonSchema: { "type": "boolean" }
						}
					}],
					result: {
						mode: "strict",
						typeSymbol: "@deepseek-ai/dsh-wrapvm-isolate/types#VmRemovalPreview",
						create: _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02PreviewRemoval_result$schema,
						jsonSchema: {
							"type": "object",
							"properties": {
								"environmentId": { "type": "string" },
								"containerId": { "type": "string" },
								"volumeName": { "type": "string" },
								"networkName": { "type": "string" },
								"displayName": { "oneOf": [{
									"type": "null",
									"const": null
								}, { "type": "string" }] },
								"hostMounts": {
									"type": "array",
									"items": { "type": "string" }
								},
								"deleteVolumes": { "type": "boolean" },
								"confirmToken": { "type": "string" },
								"expiresAt": { "type": "number" }
							},
							"required": [
								"environmentId",
								"containerId",
								"volumeName",
								"networkName",
								"displayName",
								"hostMounts",
								"deleteVolumes",
								"confirmToken",
								"expiresAt"
							],
							"additionalProperties": true
						}
					},
					sourceLocation: {
						"file": "packages/bundle/wrapvm-isolate/src/index.ts",
						"line": 335,
						"column": 9
					}
				},
				"wrapvmIsolate/v02Resume": {
					service: "wrapvmIsolate",
					invocation: { kind: "direct" },
					parameters: [{
						name: "id",
						source: "json",
						codec: {
							mode: "strict",
							typeSymbol: "@deepseek-ai/dsh-wrapvm-isolate#wrapvmIsolate/v02Resume:id",
							create: _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02Resume_parameter_0$schema,
							jsonSchema: { "type": "string" }
						},
						strictCodec: {
							mode: "strict",
							typeSymbol: "@deepseek-ai/dsh-wrapvm-isolate#wrapvmIsolate/v02Resume:id",
							create: _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02Resume_parameter_0_strict$schema,
							jsonSchema: { "type": "string" }
						}
					}, {
						name: "key",
						source: "json",
						codec: {
							mode: "strict",
							typeSymbol: "@deepseek-ai/dsh-wrapvm-isolate#wrapvmIsolate/v02Resume:key",
							create: _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02Resume_parameter_1$schema,
							jsonSchema: { "type": "string" }
						},
						strictCodec: {
							mode: "strict",
							typeSymbol: "@deepseek-ai/dsh-wrapvm-isolate#wrapvmIsolate/v02Resume:key",
							create: _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02Resume_parameter_1_strict$schema,
							jsonSchema: { "type": "string" }
						}
					}],
					result: {
						mode: "strict",
						typeSymbol: "@deepseek-ai/dsh-wrapvm-isolate/types#VmOperationView",
						create: _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02Resume_result$schema,
						jsonSchema: {
							"type": "object",
							"properties": {
								"id": { "type": "string" },
								"environmentId": { "type": "string" },
								"kind": { "type": "string" },
								"state": {
									"type": "string",
									"enum": [
										"running",
										"requested",
										"completed",
										"failed"
									]
								},
								"error": { "oneOf": [{
									"type": "null",
									"const": null
								}, { "type": "string" }] },
								"errorCode": { "oneOf": [{
									"type": "null",
									"const": null
								}, { "type": "string" }] },
								"requestedAt": { "oneOf": [{
									"type": "null",
									"const": null
								}, { "type": "number" }] },
								"settledAt": { "oneOf": [{
									"type": "null",
									"const": null
								}, { "type": "number" }] }
							},
							"required": [
								"id",
								"environmentId",
								"kind",
								"state",
								"error",
								"errorCode",
								"requestedAt",
								"settledAt"
							],
							"additionalProperties": true
						}
					},
					sourceLocation: {
						"file": "packages/bundle/wrapvm-isolate/src/index.ts",
						"line": 331,
						"column": 9
					}
				},
				"wrapvmIsolate/v02Snapshot": {
					service: "wrapvmIsolate",
					invocation: { kind: "direct" },
					parameters: [{
						name: "sessionKey",
						source: "json",
						codec: {
							mode: "strict",
							typeSymbol: "@deepseek-ai/dsh-wrapvm-isolate#wrapvmIsolate/v02Snapshot:sessionKey",
							create: _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02Snapshot_parameter_0$schema,
							jsonSchema: { "oneOf": [{
								"type": "null",
								"const": null
							}, { "type": "string" }] }
						},
						strictCodec: {
							mode: "strict",
							typeSymbol: "@deepseek-ai/dsh-wrapvm-isolate#wrapvmIsolate/v02Snapshot:sessionKey",
							create: _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02Snapshot_parameter_0_strict$schema,
							jsonSchema: { "oneOf": [{
								"type": "null",
								"const": null
							}, { "type": "string" }] }
						}
					}],
					result: {
						mode: "strict",
						typeSymbol: "@deepseek-ai/dsh-wrapvm-isolate/types#VmInventorySnapshot",
						create: _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02Snapshot_result$schema,
						jsonSchema: {
							"type": "object",
							"properties": {
								"environments": {
									"type": "array",
									"items": {
										"type": "object",
										"properties": {
											"id": { "type": "string" },
											"displayName": { "type": "string" },
											"backend": {
												"type": "string",
												"const": "docker"
											},
											"ownership": {
												"type": "string",
												"enum": ["plugin", "imported"]
											},
											"image": { "type": "string" },
											"digest": { "type": "string" },
											"createdAt": { "type": "number" },
											"mounts": {
												"type": "array",
												"items": {
													"type": "object",
													"properties": {
														"hostPath": { "type": "string" },
														"guestPath": { "type": "string" },
														"access": {
															"type": "string",
															"enum": ["read-only", "read-write"]
														}
													},
													"required": [
														"hostPath",
														"guestPath",
														"access"
													],
													"additionalProperties": true
												}
											},
											"limits": {
												"type": "object",
												"properties": {
													"cpuMillis": { "type": "number" },
													"memoryBytes": { "type": "number" },
													"diskBytes": { "oneOf": [{
														"type": "null",
														"const": null
													}, { "type": "number" }] }
												},
												"required": [
													"cpuMillis",
													"memoryBytes",
													"diskBytes"
												],
												"additionalProperties": true
											},
											"internetAccess": { "type": "boolean" },
											"desiredPhase": { "oneOf": [{
												"type": "null",
												"const": null
											}, {
												"type": "string",
												"enum": [
													"running",
													"stopped",
													"paused"
												]
											}] },
											"observed": { "oneOf": [{
												"type": "null",
												"const": null
											}, {
												"type": "object",
												"properties": {
													"phase": {
														"type": "string",
														"enum": [
															"running",
															"stopped",
															"paused",
															"missing",
															"created",
															"error"
														]
													},
													"shell": { "oneOf": [{
														"type": "object",
														"properties": {
															"kind": {
																"type": "string",
																"enum": ["available", "unavailable"]
															},
															"reason": {
																"type": "null",
																"const": null
															}
														},
														"required": ["kind", "reason"],
														"additionalProperties": true
													}, {
														"type": "object",
														"properties": {
															"kind": {
																"type": "string",
																"const": "unknown"
															},
															"reason": { "type": "string" }
														},
														"required": ["kind", "reason"],
														"additionalProperties": true
													}] },
													"browser": { "oneOf": [{
														"type": "object",
														"properties": {
															"kind": {
																"type": "string",
																"enum": ["available", "unavailable"]
															},
															"reason": {
																"type": "null",
																"const": null
															}
														},
														"required": ["kind", "reason"],
														"additionalProperties": true
													}, {
														"type": "object",
														"properties": {
															"kind": {
																"type": "string",
																"const": "unknown"
															},
															"reason": { "type": "string" }
														},
														"required": ["kind", "reason"],
														"additionalProperties": true
													}] },
													"desktop": { "oneOf": [{
														"type": "object",
														"properties": {
															"kind": {
																"type": "string",
																"enum": ["available", "unavailable"]
															},
															"reason": {
																"type": "null",
																"const": null
															}
														},
														"required": ["kind", "reason"],
														"additionalProperties": true
													}, {
														"type": "object",
														"properties": {
															"kind": {
																"type": "string",
																"const": "unknown"
															},
															"reason": { "type": "string" }
														},
														"required": ["kind", "reason"],
														"additionalProperties": true
													}] },
													"hostControlPlane": { "oneOf": [{
														"type": "object",
														"properties": {
															"kind": {
																"type": "string",
																"enum": ["available", "unavailable"]
															},
															"reason": {
																"type": "null",
																"const": null
															}
														},
														"required": ["kind", "reason"],
														"additionalProperties": true
													}, {
														"type": "object",
														"properties": {
															"kind": {
																"type": "string",
																"const": "unknown"
															},
															"reason": { "type": "string" }
														},
														"required": ["kind", "reason"],
														"additionalProperties": true
													}] },
													"observedAt": { "oneOf": [{
														"type": "null",
														"const": null
													}, { "type": "number" }] }
												},
												"required": [
													"phase",
													"shell",
													"browser",
													"desktop",
													"hostControlPlane",
													"observedAt"
												],
												"additionalProperties": true
											}] },
											"resources": { "oneOf": [{
												"type": "null",
												"const": null
											}, {
												"type": "object",
												"properties": {
													"takenAt": { "type": "number" },
													"stale": { "type": "boolean" },
													"cpuPercent": { "oneOf": [{
														"type": "null",
														"const": null
													}, { "type": "number" }] },
													"memoryUsedBytes": { "oneOf": [{
														"type": "null",
														"const": null
													}, { "type": "number" }] },
													"memoryLimitBytes": { "oneOf": [{
														"type": "null",
														"const": null
													}, { "type": "number" }] },
													"writableLayerBytes": { "oneOf": [{
														"type": "null",
														"const": null
													}, { "type": "number" }] },
													"volumeUsedBytes": { "oneOf": [{
														"type": "null",
														"const": null
													}, { "type": "number" }] }
												},
												"required": [
													"takenAt",
													"stale",
													"cpuPercent",
													"memoryUsedBytes",
													"memoryLimitBytes",
													"writableLayerBytes",
													"volumeUsedBytes"
												],
												"additionalProperties": true
											}] },
											"bindings": {
												"type": "array",
												"items": {
													"type": "object",
													"properties": {
														"sessionKey": { "type": "string" },
														"environmentId": { "type": "string" },
														"generation": { "type": "number" },
														"history": {
															"type": "array",
															"items": { "type": "string" }
														}
													},
													"required": [
														"sessionKey",
														"environmentId",
														"generation",
														"history"
													],
													"additionalProperties": true
												}
											},
											"bindingsComplete": { "type": "boolean" },
											"operations": {
												"type": "array",
												"items": {
													"type": "object",
													"properties": {
														"id": { "type": "string" },
														"environmentId": { "type": "string" },
														"kind": { "type": "string" },
														"state": {
															"type": "string",
															"enum": [
																"running",
																"requested",
																"completed",
																"failed"
															]
														},
														"error": { "oneOf": [{
															"type": "null",
															"const": null
														}, { "type": "string" }] },
														"errorCode": { "oneOf": [{
															"type": "null",
															"const": null
														}, { "type": "string" }] },
														"requestedAt": { "oneOf": [{
															"type": "null",
															"const": null
														}, { "type": "number" }] },
														"settledAt": { "oneOf": [{
															"type": "null",
															"const": null
														}, { "type": "number" }] }
													},
													"required": [
														"id",
														"environmentId",
														"kind",
														"state",
														"error",
														"errorCode",
														"requestedAt",
														"settledAt"
													],
													"additionalProperties": true
												}
											},
											"uncertainty": { "oneOf": [{
												"type": "null",
												"const": null
											}, { "type": "string" }] }
										},
										"required": [
											"id",
											"displayName",
											"backend",
											"ownership",
											"image",
											"digest",
											"createdAt",
											"mounts",
											"limits",
											"internetAccess",
											"desiredPhase",
											"observed",
											"resources",
											"bindings",
											"bindingsComplete",
											"operations",
											"uncertainty"
										],
										"additionalProperties": true
									}
								},
								"policy": { "oneOf": [{
									"type": "null",
									"const": null
								}, {
									"type": "object",
									"properties": {
										"sessionKey": { "type": "string" },
										"mode": {
											"type": "string",
											"enum": [
												"normal",
												"activating",
												"protected",
												"protected-unavailable"
											]
										},
										"generation": { "type": "number" },
										"stage": { "type": "string" },
										"environmentId": { "oneOf": [{
											"type": "null",
											"const": null
										}, { "type": "string" }] },
										"reason": { "oneOf": [{
											"type": "null",
											"const": null
										}, { "type": "string" }] }
									},
									"required": [
										"sessionKey",
										"mode",
										"generation",
										"stage",
										"environmentId",
										"reason"
									],
									"additionalProperties": true
								}] },
								"binding": { "oneOf": [{
									"type": "null",
									"const": null
								}, {
									"type": "object",
									"properties": {
										"sessionKey": { "type": "string" },
										"environmentId": { "type": "string" },
										"generation": { "type": "number" },
										"history": {
											"type": "array",
											"items": { "type": "string" }
										}
									},
									"required": [
										"sessionKey",
										"environmentId",
										"generation",
										"history"
									],
									"additionalProperties": true
								}] },
								"bindingComplete": { "type": "boolean" }
							},
							"required": [
								"environments",
								"policy",
								"binding",
								"bindingComplete"
							],
							"additionalProperties": true
						}
					},
					sourceLocation: {
						"file": "packages/bundle/wrapvm-isolate/src/index.ts",
						"line": 288,
						"column": 9
					}
				},
				"wrapvmIsolate/v02Start": {
					service: "wrapvmIsolate",
					invocation: { kind: "direct" },
					parameters: [{
						name: "id",
						source: "json",
						codec: {
							mode: "strict",
							typeSymbol: "@deepseek-ai/dsh-wrapvm-isolate#wrapvmIsolate/v02Start:id",
							create: _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02Start_parameter_0$schema,
							jsonSchema: { "type": "string" }
						},
						strictCodec: {
							mode: "strict",
							typeSymbol: "@deepseek-ai/dsh-wrapvm-isolate#wrapvmIsolate/v02Start:id",
							create: _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02Start_parameter_0_strict$schema,
							jsonSchema: { "type": "string" }
						}
					}, {
						name: "key",
						source: "json",
						codec: {
							mode: "strict",
							typeSymbol: "@deepseek-ai/dsh-wrapvm-isolate#wrapvmIsolate/v02Start:key",
							create: _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02Start_parameter_1$schema,
							jsonSchema: { "type": "string" }
						},
						strictCodec: {
							mode: "strict",
							typeSymbol: "@deepseek-ai/dsh-wrapvm-isolate#wrapvmIsolate/v02Start:key",
							create: _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02Start_parameter_1_strict$schema,
							jsonSchema: { "type": "string" }
						}
					}],
					result: {
						mode: "strict",
						typeSymbol: "@deepseek-ai/dsh-wrapvm-isolate/types#VmOperationView",
						create: _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02Start_result$schema,
						jsonSchema: {
							"type": "object",
							"properties": {
								"id": { "type": "string" },
								"environmentId": { "type": "string" },
								"kind": { "type": "string" },
								"state": {
									"type": "string",
									"enum": [
										"running",
										"requested",
										"completed",
										"failed"
									]
								},
								"error": { "oneOf": [{
									"type": "null",
									"const": null
								}, { "type": "string" }] },
								"errorCode": { "oneOf": [{
									"type": "null",
									"const": null
								}, { "type": "string" }] },
								"requestedAt": { "oneOf": [{
									"type": "null",
									"const": null
								}, { "type": "number" }] },
								"settledAt": { "oneOf": [{
									"type": "null",
									"const": null
								}, { "type": "number" }] }
							},
							"required": [
								"id",
								"environmentId",
								"kind",
								"state",
								"error",
								"errorCode",
								"requestedAt",
								"settledAt"
							],
							"additionalProperties": true
						}
					},
					sourceLocation: {
						"file": "packages/bundle/wrapvm-isolate/src/index.ts",
						"line": 325,
						"column": 9
					}
				},
				"wrapvmIsolate/v02Stop": {
					service: "wrapvmIsolate",
					invocation: { kind: "direct" },
					parameters: [{
						name: "id",
						source: "json",
						codec: {
							mode: "strict",
							typeSymbol: "@deepseek-ai/dsh-wrapvm-isolate#wrapvmIsolate/v02Stop:id",
							create: _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02Stop_parameter_0$schema,
							jsonSchema: { "type": "string" }
						},
						strictCodec: {
							mode: "strict",
							typeSymbol: "@deepseek-ai/dsh-wrapvm-isolate#wrapvmIsolate/v02Stop:id",
							create: _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02Stop_parameter_0_strict$schema,
							jsonSchema: { "type": "string" }
						}
					}, {
						name: "key",
						source: "json",
						codec: {
							mode: "strict",
							typeSymbol: "@deepseek-ai/dsh-wrapvm-isolate#wrapvmIsolate/v02Stop:key",
							create: _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02Stop_parameter_1$schema,
							jsonSchema: { "type": "string" }
						},
						strictCodec: {
							mode: "strict",
							typeSymbol: "@deepseek-ai/dsh-wrapvm-isolate#wrapvmIsolate/v02Stop:key",
							create: _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02Stop_parameter_1_strict$schema,
							jsonSchema: { "type": "string" }
						}
					}],
					result: {
						mode: "strict",
						typeSymbol: "@deepseek-ai/dsh-wrapvm-isolate/types#VmOperationView",
						create: _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02Stop_result$schema,
						jsonSchema: {
							"type": "object",
							"properties": {
								"id": { "type": "string" },
								"environmentId": { "type": "string" },
								"kind": { "type": "string" },
								"state": {
									"type": "string",
									"enum": [
										"running",
										"requested",
										"completed",
										"failed"
									]
								},
								"error": { "oneOf": [{
									"type": "null",
									"const": null
								}, { "type": "string" }] },
								"errorCode": { "oneOf": [{
									"type": "null",
									"const": null
								}, { "type": "string" }] },
								"requestedAt": { "oneOf": [{
									"type": "null",
									"const": null
								}, { "type": "number" }] },
								"settledAt": { "oneOf": [{
									"type": "null",
									"const": null
								}, { "type": "number" }] }
							},
							"required": [
								"id",
								"environmentId",
								"kind",
								"state",
								"error",
								"errorCode",
								"requestedAt",
								"settledAt"
							],
							"additionalProperties": true
						}
					},
					sourceLocation: {
						"file": "packages/bundle/wrapvm-isolate/src/index.ts",
						"line": 327,
						"column": 9
					}
				},
				"wrapvmIsolate/v02Unbind": {
					service: "wrapvmIsolate",
					invocation: { kind: "direct" },
					parameters: [{
						name: "session",
						source: "json",
						codec: {
							mode: "strict",
							typeSymbol: "@deepseek-ai/dsh-wrapvm-isolate#wrapvmIsolate/v02Unbind:session",
							create: _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02Unbind_parameter_0$schema,
							jsonSchema: { "type": "string" }
						},
						strictCodec: {
							mode: "strict",
							typeSymbol: "@deepseek-ai/dsh-wrapvm-isolate#wrapvmIsolate/v02Unbind:session",
							create: _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02Unbind_parameter_0_strict$schema,
							jsonSchema: { "type": "string" }
						}
					}, {
						name: "_key",
						source: "json",
						codec: {
							mode: "strict",
							typeSymbol: "@deepseek-ai/dsh-wrapvm-isolate#wrapvmIsolate/v02Unbind:_key",
							create: _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02Unbind_parameter_1$schema,
							jsonSchema: { "type": "string" }
						},
						strictCodec: {
							mode: "strict",
							typeSymbol: "@deepseek-ai/dsh-wrapvm-isolate#wrapvmIsolate/v02Unbind:_key",
							create: _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02Unbind_parameter_1_strict$schema,
							jsonSchema: { "type": "string" }
						}
					}],
					result: {
						mode: "strict",
						typeSymbol: "@deepseek-ai/dsh-wrapvm-isolate/types#VmOperationView",
						create: _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02Unbind_result$schema,
						jsonSchema: {
							"type": "object",
							"properties": {
								"id": { "type": "string" },
								"environmentId": { "type": "string" },
								"kind": { "type": "string" },
								"state": {
									"type": "string",
									"enum": [
										"running",
										"requested",
										"completed",
										"failed"
									]
								},
								"error": { "oneOf": [{
									"type": "null",
									"const": null
								}, { "type": "string" }] },
								"errorCode": { "oneOf": [{
									"type": "null",
									"const": null
								}, { "type": "string" }] },
								"requestedAt": { "oneOf": [{
									"type": "null",
									"const": null
								}, { "type": "number" }] },
								"settledAt": { "oneOf": [{
									"type": "null",
									"const": null
								}, { "type": "number" }] }
							},
							"required": [
								"id",
								"environmentId",
								"kind",
								"state",
								"error",
								"errorCode",
								"requestedAt",
								"settledAt"
							],
							"additionalProperties": true
						}
					},
					sourceLocation: {
						"file": "packages/bundle/wrapvm-isolate/src/index.ts",
						"line": 349,
						"column": 9
					}
				},
				"wrapvmIsolate/v02UpdateLimits": {
					service: "wrapvmIsolate",
					invocation: { kind: "direct" },
					parameters: [
						{
							name: "id",
							source: "json",
							codec: {
								mode: "strict",
								typeSymbol: "@deepseek-ai/dsh-wrapvm-isolate#wrapvmIsolate/v02UpdateLimits:id",
								create: _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02UpdateLimits_parameter_0$schema,
								jsonSchema: { "type": "string" }
							},
							strictCodec: {
								mode: "strict",
								typeSymbol: "@deepseek-ai/dsh-wrapvm-isolate#wrapvmIsolate/v02UpdateLimits:id",
								create: _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02UpdateLimits_parameter_0_strict$schema,
								jsonSchema: { "type": "string" }
							}
						},
						{
							name: "limits",
							source: "json",
							codec: {
								mode: "strict",
								typeSymbol: "@deepseek-ai/dsh-wrapvm-isolate#wrapvmIsolate/v02UpdateLimits:limits",
								create: _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02UpdateLimits_parameter_1$schema,
								jsonSchema: {
									"type": "object",
									"properties": {
										"cpuMillis": { "type": "number" },
										"memoryBytes": { "type": "number" },
										"diskBytes": { "oneOf": [{
											"type": "null",
											"const": null
										}, { "type": "number" }] }
									},
									"required": [
										"cpuMillis",
										"memoryBytes",
										"diskBytes"
									],
									"additionalProperties": true
								}
							},
							strictCodec: {
								mode: "strict",
								typeSymbol: "@deepseek-ai/dsh-wrapvm-isolate#wrapvmIsolate/v02UpdateLimits:limits",
								create: _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02UpdateLimits_parameter_1_strict$schema,
								jsonSchema: {
									"type": "object",
									"properties": {
										"cpuMillis": { "type": "number" },
										"memoryBytes": { "type": "number" },
										"diskBytes": { "oneOf": [{
											"type": "null",
											"const": null
										}, { "type": "number" }] }
									},
									"required": [
										"cpuMillis",
										"memoryBytes",
										"diskBytes"
									],
									"additionalProperties": false
								}
							}
						},
						{
							name: "key",
							source: "json",
							codec: {
								mode: "strict",
								typeSymbol: "@deepseek-ai/dsh-wrapvm-isolate#wrapvmIsolate/v02UpdateLimits:key",
								create: _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02UpdateLimits_parameter_2$schema,
								jsonSchema: { "type": "string" }
							},
							strictCodec: {
								mode: "strict",
								typeSymbol: "@deepseek-ai/dsh-wrapvm-isolate#wrapvmIsolate/v02UpdateLimits:key",
								create: _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02UpdateLimits_parameter_2_strict$schema,
								jsonSchema: { "type": "string" }
							}
						}
					],
					result: {
						mode: "strict",
						typeSymbol: "@deepseek-ai/dsh-wrapvm-isolate/types#VmOperationView",
						create: _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02UpdateLimits_result$schema,
						jsonSchema: {
							"type": "object",
							"properties": {
								"id": { "type": "string" },
								"environmentId": { "type": "string" },
								"kind": { "type": "string" },
								"state": {
									"type": "string",
									"enum": [
										"running",
										"requested",
										"completed",
										"failed"
									]
								},
								"error": { "oneOf": [{
									"type": "null",
									"const": null
								}, { "type": "string" }] },
								"errorCode": { "oneOf": [{
									"type": "null",
									"const": null
								}, { "type": "string" }] },
								"requestedAt": { "oneOf": [{
									"type": "null",
									"const": null
								}, { "type": "number" }] },
								"settledAt": { "oneOf": [{
									"type": "null",
									"const": null
								}, { "type": "number" }] }
							},
							"required": [
								"id",
								"environmentId",
								"kind",
								"state",
								"error",
								"errorCode",
								"requestedAt",
								"settledAt"
							],
							"additionalProperties": true
						}
					},
					sourceLocation: {
						"file": "packages/bundle/wrapvm-isolate/src/index.ts",
						"line": 333,
						"column": 9
					}
				},
				"wrapvmIsolate/v02ViewerUrl": {
					service: "wrapvmIsolate",
					invocation: { kind: "direct" },
					parameters: [
						{
							name: "sessionKey",
							source: "json",
							codec: {
								mode: "strict",
								typeSymbol: "@deepseek-ai/dsh-wrapvm-isolate#wrapvmIsolate/v02ViewerUrl:sessionKey",
								create: _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02ViewerUrl_parameter_0$schema,
								jsonSchema: { "type": "string" }
							},
							strictCodec: {
								mode: "strict",
								typeSymbol: "@deepseek-ai/dsh-wrapvm-isolate#wrapvmIsolate/v02ViewerUrl:sessionKey",
								create: _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02ViewerUrl_parameter_0_strict$schema,
								jsonSchema: { "type": "string" }
							}
						},
						{
							name: "epoch",
							source: "json",
							codec: {
								mode: "strict",
								typeSymbol: "@deepseek-ai/dsh-wrapvm-isolate#wrapvmIsolate/v02ViewerUrl:epoch",
								create: _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02ViewerUrl_parameter_1$schema,
								jsonSchema: { "type": "string" }
							},
							strictCodec: {
								mode: "strict",
								typeSymbol: "@deepseek-ai/dsh-wrapvm-isolate#wrapvmIsolate/v02ViewerUrl:epoch",
								create: _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02ViewerUrl_parameter_1_strict$schema,
								jsonSchema: { "type": "string" }
							}
						},
						{
							name: "revision",
							source: "json",
							codec: {
								mode: "strict",
								typeSymbol: "@deepseek-ai/dsh-wrapvm-isolate#wrapvmIsolate/v02ViewerUrl:revision",
								create: _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02ViewerUrl_parameter_2$schema,
								jsonSchema: { "type": "number" }
							},
							strictCodec: {
								mode: "strict",
								typeSymbol: "@deepseek-ai/dsh-wrapvm-isolate#wrapvmIsolate/v02ViewerUrl:revision",
								create: _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02ViewerUrl_parameter_2_strict$schema,
								jsonSchema: { "type": "number" }
							}
						}
					],
					result: {
						mode: "strict",
						typeSymbol: "@deepseek-ai/dsh-wrapvm-isolate#wrapvmIsolate/v02ViewerUrl:result",
						create: _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02ViewerUrl_result$schema,
						jsonSchema: { "oneOf": [{
							"type": "null",
							"const": null
						}, {
							"type": "object",
							"properties": {
								"url": { "type": "string" },
								"expiresAt": { "oneOf": [{
									"type": "null",
									"const": null
								}, { "type": "number" }] },
								"epoch": { "type": "string" },
								"revision": { "type": "number" }
							},
							"required": [
								"url",
								"expiresAt",
								"epoch",
								"revision"
							],
							"additionalProperties": true
						}] }
					},
					sourceLocation: {
						"file": "packages/bundle/wrapvm-isolate/src/index.ts",
						"line": 372,
						"column": 9
					}
				},
				"wrapvmIsolate/v02WatchResources": {
					service: "wrapvmIsolate",
					description: "Watch shared resource samples for managed environments until cancellation.",
					mode: "stream",
					invocation: { kind: "direct" },
					parameters: [{
						name: "environmentIds",
						source: "json",
						codec: {
							mode: "strict",
							typeSymbol: "@deepseek-ai/dsh-wrapvm-isolate#wrapvmIsolate/v02WatchResources:environmentIds",
							create: _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02WatchResources_parameter_0$schema,
							jsonSchema: {
								"type": "array",
								"items": { "type": "string" }
							}
						},
						strictCodec: {
							mode: "strict",
							typeSymbol: "@deepseek-ai/dsh-wrapvm-isolate#wrapvmIsolate/v02WatchResources:environmentIds",
							create: _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02WatchResources_parameter_0_strict$schema,
							jsonSchema: {
								"type": "array",
								"items": { "type": "string" }
							}
						}
					}],
					cancellation: { parameter: "signal" },
					result: {
						mode: "strict",
						typeSymbol: "@deepseek-ai/dsh-wrapvm-isolate/types#VmResourceUpdate",
						create: _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02WatchResources_result$schema,
						jsonSchema: {
							"type": "object",
							"properties": {
								"environmentId": { "type": "string" },
								"resources": {
									"type": "object",
									"properties": {
										"takenAt": { "type": "number" },
										"stale": { "type": "boolean" },
										"cpuPercent": { "oneOf": [{
											"type": "null",
											"const": null
										}, { "type": "number" }] },
										"memoryUsedBytes": { "oneOf": [{
											"type": "null",
											"const": null
										}, { "type": "number" }] },
										"memoryLimitBytes": { "oneOf": [{
											"type": "null",
											"const": null
										}, { "type": "number" }] },
										"writableLayerBytes": { "oneOf": [{
											"type": "null",
											"const": null
										}, { "type": "number" }] },
										"volumeUsedBytes": { "oneOf": [{
											"type": "null",
											"const": null
										}, { "type": "number" }] }
									},
									"required": [
										"takenAt",
										"stale",
										"cpuPercent",
										"memoryUsedBytes",
										"memoryLimitBytes",
										"writableLayerBytes",
										"volumeUsedBytes"
									],
									"additionalProperties": true
								}
							},
							"required": ["environmentId", "resources"],
							"additionalProperties": true
						}
					},
					sourceLocation: {
						"file": "packages/bundle/wrapvm-isolate/src/index.ts",
						"line": 407,
						"column": 10
					}
				},
				"wrapvmIsolate/v02WatchSession": {
					service: "wrapvmIsolate",
					mode: "stream",
					invocation: { kind: "direct" },
					parameters: [{
						name: "sessionKey",
						source: "json",
						codec: {
							mode: "strict",
							typeSymbol: "@deepseek-ai/dsh-wrapvm-isolate#wrapvmIsolate/v02WatchSession:sessionKey",
							create: _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02WatchSession_parameter_0$schema,
							jsonSchema: { "type": "string" }
						},
						strictCodec: {
							mode: "strict",
							typeSymbol: "@deepseek-ai/dsh-wrapvm-isolate#wrapvmIsolate/v02WatchSession:sessionKey",
							create: _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02WatchSession_parameter_0_strict$schema,
							jsonSchema: { "type": "string" }
						}
					}],
					cancellation: { parameter: "signal" },
					result: {
						mode: "strict",
						typeSymbol: "@deepseek-ai/dsh-wrapvm-isolate/types#VmSessionView",
						create: _deepseek_ai_dsh_wrapvm_isolate_wrapvmIsolate_v02WatchSession_result$schema,
						jsonSchema: {
							"type": "object",
							"properties": {
								"epoch": { "type": "string" },
								"revision": { "type": "number" },
								"policy": {
									"type": "object",
									"properties": {
										"sessionKey": { "type": "string" },
										"mode": {
											"type": "string",
											"enum": [
												"normal",
												"activating",
												"protected",
												"protected-unavailable"
											]
										},
										"generation": { "type": "number" },
										"stage": { "type": "string" },
										"environmentId": { "oneOf": [{
											"type": "null",
											"const": null
										}, { "type": "string" }] },
										"reason": { "oneOf": [{
											"type": "null",
											"const": null
										}, { "type": "string" }] }
									},
									"required": [
										"sessionKey",
										"mode",
										"generation",
										"stage",
										"environmentId",
										"reason"
									],
									"additionalProperties": true
								},
								"binding": { "oneOf": [{
									"type": "null",
									"const": null
								}, {
									"type": "object",
									"properties": {
										"sessionKey": { "type": "string" },
										"environmentId": { "type": "string" },
										"generation": { "type": "number" },
										"history": {
											"type": "array",
											"items": { "type": "string" }
										}
									},
									"required": [
										"sessionKey",
										"environmentId",
										"generation",
										"history"
									],
									"additionalProperties": true
								}] },
								"bindingComplete": { "type": "boolean" }
							},
							"required": [
								"epoch",
								"revision",
								"policy",
								"binding",
								"bindingComplete"
							],
							"additionalProperties": true
						}
					},
					sourceLocation: {
						"file": "packages/bundle/wrapvm-isolate/src/index.ts",
						"line": 357,
						"column": 10
					}
				}
			}
		}, zod.z);
		//#endregion
		//#region ../../util/crypto/lib/index.js
		/**
		* Random v4 UUID, minted from `crypto.getRandomValues`.
		* @returns the UUID string.
		*/
		function randomUUID() {
			const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
			const hex = Array.from(bytes, (byte, index) => {
				return (index === 6 ? byte & 15 | 64 : index === 8 ? byte & 63 | 128 : byte).toString(16).padStart(2, "0");
			}).join("");
			return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
		}
		//#endregion
		//#region lib/types/client/icon.js
		/** Section icon shown in the settings navigation rail. */
		function WrapvmSectionIcon({ size, active }) {
			return (0, react_jsx_runtime.jsxs)("svg", {
				width: size,
				height: size,
				viewBox: "0 0 24 24",
				fill: "none",
				children: [
					(0, react_jsx_runtime.jsx)("rect", {
						x: "3",
						y: "5",
						width: "18",
						height: "14",
						rx: "2",
						fill: "none",
						stroke: "currentColor",
						strokeWidth: active ? 1.8 : 1.5
					}),
					(0, react_jsx_runtime.jsx)("rect", {
						x: "6.5",
						y: "9.5",
						width: "11",
						height: "6",
						rx: "1.2",
						fill: "none",
						stroke: "currentColor",
						strokeWidth: "1.2"
					}),
					(0, react_jsx_runtime.jsx)("circle", {
						cx: "9",
						cy: "12.5",
						r: "1",
						fill: "currentColor"
					}),
					(0, react_jsx_runtime.jsx)("circle", {
						cx: "12",
						cy: "12.5",
						r: "1",
						fill: "currentColor"
					}),
					(0, react_jsx_runtime.jsx)("circle", {
						cx: "15",
						cy: "12.5",
						r: "1",
						fill: "currentColor"
					})
				]
			});
		}
		//#endregion
		//#region \0dsh-css:/Users/alexintosh/Code/LLLM/TESTS/GML5.3-Flash-EXLR8/deepseek-harness/packages/bundle/wrapvm-isolate/src/client/panel.module.css.mjs
		const css = ".nUT67G_page{box-sizing:border-box;height:100%;min-height:0;color:var(--dsw-alias-label-primary);padding:28px clamp(20px,4vw,48px) 48px;font-size:13px;line-height:20px;overflow-y:auto}[data-platform=darwin] .nUT67G_page{padding-top:calc(28px + var(--dsh-frame-top-clearance,0px))}.nUT67G_content{width:100%;max-width:960px;margin:0 auto}.nUT67G_header{flex-wrap:wrap;justify-content:space-between;align-items:flex-start;gap:16px;margin-bottom:28px;display:flex}.nUT67G_heading{flex:1;min-width:180px}.nUT67G_page h1{margin:0;font-size:20px;font-weight:500;line-height:28px}.nUT67G_page h2,.nUT67G_section h2{margin:0;font-size:14px;font-weight:500;line-height:22px}.nUT67G_page p,.nUT67G_section p,.nUT67G_form p{margin:0}.nUT67G_intro{color:var(--dsw-alias-label-secondary);margin-top:4px!important}.nUT67G_controls{flex-wrap:wrap;align-items:center;gap:8px;display:flex}.nUT67G_summary{border-bottom:.5px solid var(--dsw-alias-border-l3);color:var(--dsw-alias-label-tertiary);gap:20px;margin-bottom:20px;padding-bottom:16px;display:flex}.nUT67G_summary strong{color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums;margin-right:6px;font-weight:500}.nUT67G_list{flex-direction:column;gap:16px;display:flex}.nUT67G_card{border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-lg);min-width:0;padding:20px}.nUT67G_cardHead{align-items:flex-start;gap:12px;margin-bottom:20px;display:flex}.nUT67G_cardIdentity{flex:1;min-width:0}.nUT67G_cardImage{color:var(--dsw-alias-label-tertiary);overflow-wrap:anywhere;font-size:12px;line-height:18px;margin-top:2px!important}.nUT67G_status{color:var(--dsw-alias-label-secondary);flex-shrink:0;align-items:center;gap:6px;font-size:12px;line-height:20px;display:inline-flex}.nUT67G_metrics{grid-template-columns:repeat(3,minmax(0,1fr));gap:20px;margin:0 0 20px;display:grid}.nUT67G_metrics dt{color:var(--dsw-alias-label-tertiary);margin-bottom:4px;font-size:12px;line-height:18px}.nUT67G_metrics dd{font-variant-numeric:tabular-nums;margin:0;font-size:16px;line-height:24px}.nUT67G_metricNote{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px;display:block}.nUT67G_cardFooter{border-top:.5px solid var(--dsw-alias-border-l3);flex-wrap:wrap;justify-content:space-between;align-items:center;gap:12px;padding-top:12px;display:flex}.nUT67G_details{min-width:0;color:var(--dsw-alias-label-secondary)}.nUT67G_details summary{cursor:pointer;width:fit-content;font-size:13px;line-height:20px}.nUT67G_details[open] summary{margin-bottom:12px}.nUT67G_details dl,.nUT67G_facts{grid-template-columns:minmax(80px,auto) minmax(0,1fr);gap:8px 16px;margin:0;font-size:12px;line-height:18px;display:grid}.nUT67G_details dd,.nUT67G_facts dd{overflow-wrap:anywhere;margin:0}.nUT67G_details dt,.nUT67G_facts dt{color:var(--dsw-alias-label-tertiary)}.nUT67G_card>.nUT67G_details{margin-top:16px}.nUT67G_empty{text-align:center;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-lg);flex-direction:column;align-items:center;gap:8px;padding:64px 20px;display:flex}.nUT67G_empty p{max-width:360px;color:var(--dsw-alias-label-tertiary)}.nUT67G_emptyIcon{border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-lg);width:48px;height:48px;color:var(--dsw-alias-label-secondary);justify-content:center;align-items:center;margin-bottom:8px;display:flex}.nUT67G_empty .nUT67G_controls{margin-top:12px}.nUT67G_notice{border-radius:var(--dsw-radius-sm);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);overflow-wrap:anywhere;padding:10px 12px;font-size:13px;line-height:20px}.nUT67G_error{color:var(--dsw-alias-state-error-primary);overflow-wrap:anywhere;padding:10px 0;font-size:13px;line-height:20px}.nUT67G_danger{color:var(--dsw-alias-state-error-primary)}.nUT67G_form{flex-direction:column;gap:20px;min-width:0;font-size:13px;line-height:20px;display:flex}.nUT67G_form fieldset{border:0;flex-direction:column;gap:20px;min-width:0;margin:0;padding:0;display:flex}.nUT67G_formRow{grid-template-columns:repeat(2,minmax(0,1fr));gap:16px;display:grid}.nUT67G_field{flex-direction:column;gap:6px;min-width:0;font-size:13px;line-height:20px;display:flex}.nUT67G_field>span:first-child{font-weight:500}.nUT67G_input{box-sizing:border-box;width:100%}.nUT67G_hint{color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}.nUT67G_form .nUT67G_details{border-top:.5px solid var(--dsw-alias-border-l3);padding-top:16px}.nUT67G_form .nUT67G_details[open]{flex-direction:column;gap:12px;display:flex}.nUT67G_network{flex-direction:column;gap:6px;display:flex}.nUT67G_modal{width:min(480px,100vw - 40px)}.nUT67G_section{box-sizing:border-box;width:100%;min-width:0;color:var(--dsw-alias-label-primary);flex-direction:column;gap:16px;font-size:13px;line-height:20px;display:flex}.nUT67G_session{height:100%;padding:16px;overflow-y:auto}.nUT67G_settings .nUT67G_session{padding:0}.nUT67G_selector{border-bottom:.5px solid var(--dsw-alias-border-l3);flex-direction:column;gap:12px;padding-bottom:16px;display:flex}.nUT67G_select{box-sizing:border-box;border:.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);width:100%;min-width:0;height:36px;color:var(--dsw-alias-label-primary);font:inherit;padding:0 10px}.nUT67G_viewerSection{flex:1;min-height:0}.nUT67G_viewerHead{flex-wrap:wrap;justify-content:space-between;align-items:center;gap:8px;display:flex}.nUT67G_viewerEmpty{box-sizing:border-box;text-align:center;border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-lg);flex-direction:column;justify-content:center;align-items:center;gap:12px;min-height:220px;padding:24px 16px;display:flex}.nUT67G_viewerEmpty p{color:var(--dsw-alias-label-tertiary);max-width:260px}.nUT67G_viewer{border:.5px solid var(--dsw-alias-border-l3);border-radius:var(--dsw-radius-md);box-sizing:border-box;flex:1;width:100%;height:62vh;min-height:360px;display:block}.nUT67G_loading{justify-content:center;align-items:center;min-height:160px;display:flex}.nUT67G_skeleton{border-radius:var(--dsw-radius-lg);background:var(--dsw-alias-bg-skeleton);height:120px}.nUT67G_section :is(button,select,summary):focus-visible,.nUT67G_page :is(button,summary):focus-visible,.nUT67G_form summary:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:2px}@media (width<=600px){.nUT67G_header{gap:16px}.nUT67G_card{padding:16px}.nUT67G_metrics{gap:12px}.nUT67G_metrics dd{font-size:14px;line-height:22px}.nUT67G_formRow{grid-template-columns:1fr}.nUT67G_empty{padding:40px 16px}}@media (pointer:coarse){.nUT67G_form input,.nUT67G_select{font-size:16px}}.nUT67G_form h3{margin:0;font-size:14px;font-weight:500;line-height:22px}";
		const tagId = "@deepseek-ai/dsh-wrapvm-isolate/panel.module.css";
		if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "@deepseek-ai/dsh-wrapvm-isolate";
			tag.dataset.pluginCss = tagId;
			tag.textContent = css;
			document.head.appendChild(tag);
		}
		var panel_module_css_default = {
			"card": "nUT67G_card",
			"cardFooter": "nUT67G_cardFooter",
			"cardHead": "nUT67G_cardHead",
			"cardIdentity": "nUT67G_cardIdentity",
			"cardImage": "nUT67G_cardImage",
			"content": "nUT67G_content",
			"controls": "nUT67G_controls",
			"danger": "nUT67G_danger",
			"details": "nUT67G_details",
			"empty": "nUT67G_empty",
			"emptyIcon": "nUT67G_emptyIcon",
			"error": "nUT67G_error",
			"facts": "nUT67G_facts",
			"field": "nUT67G_field",
			"form": "nUT67G_form",
			"formRow": "nUT67G_formRow",
			"header": "nUT67G_header",
			"heading": "nUT67G_heading",
			"hint": "nUT67G_hint",
			"input": "nUT67G_input",
			"intro": "nUT67G_intro",
			"list": "nUT67G_list",
			"loading": "nUT67G_loading",
			"metricNote": "nUT67G_metricNote",
			"metrics": "nUT67G_metrics",
			"modal": "nUT67G_modal",
			"network": "nUT67G_network",
			"notice": "nUT67G_notice",
			"page": "nUT67G_page",
			"section": "nUT67G_section",
			"select": "nUT67G_select",
			"selector": "nUT67G_selector",
			"session": "nUT67G_session",
			"settings": "nUT67G_settings",
			"skeleton": "nUT67G_skeleton",
			"status": "nUT67G_status",
			"summary": "nUT67G_summary",
			"viewer": "nUT67G_viewer",
			"viewerEmpty": "nUT67G_viewerEmpty",
			"viewerHead": "nUT67G_viewerHead",
			"viewerSection": "nUT67G_viewerSection"
		};
		//#endregion
		//#region lib/types/client/viewer.js
		/** Session-scoped desktop: credentials exist only in component state. */
		/** Render a viewer only while its session subscription remains current. */
		function VmViewer({ sessionKey, remote, t }) {
			const [viewState, setViewState] = (0, react.useState)(null);
			const [viewer, setViewer] = (0, react.useState)(null);
			const [error, setError] = (0, react.useState)(false);
			const [busy, setBusy] = (0, react.useState)(false);
			const generation = (0, react.useRef)(0);
			const revision = (0, react.useRef)(null);
			(0, react.useEffect)(() => {
				const epoch = ++generation.current;
				revision.current = null;
				setViewState(null);
				setViewer(null);
				setError(false);
				setBusy(false);
				let subscription;
				(async () => {
					try {
						if (!remote.v02WatchSession) throw new Error("Session stream unavailable");
						subscription = remote.v02WatchSession(sessionKey);
						const iterator = subscription[Symbol.asyncIterator]();
						while (generation.current === epoch) {
							const next = await iterator.next();
							if (generation.current !== epoch) return;
							if (next.done) break;
							if (revision.current?.epoch !== next.value.epoch || revision.current.revision !== next.value.revision) setViewer(null);
							revision.current = {
								epoch: next.value.epoch,
								revision: next.value.revision
							};
							setViewState({
								session: sessionKey,
								source: remote,
								value: next.value
							});
						}
					} catch {} finally {
						if (generation.current === epoch) {
							revision.current = null;
							setViewer(null);
							setViewState(null);
							setError(true);
							setBusy(false);
						}
					}
				})();
				return () => {
					generation.current++;
					revision.current = null;
					subscription?.dispose();
				};
			}, [remote, sessionKey]);
			const view = viewState?.session === sessionKey && viewState.source === remote ? viewState.value : null;
			const currentViewer = viewer?.session === sessionKey && viewer.source === remote ? viewer : null;
			(0, react.useEffect)(() => {
				if (currentViewer?.expiresAt == null) return;
				const timer = setTimeout(() => {
					setViewer(null);
				}, Math.max(0, currentViewer.expiresAt - Date.now()));
				return () => {
					clearTimeout(timer);
				};
			}, [currentViewer]);
			const open = async () => {
				const expected = revision.current, epoch = generation.current;
				if (expected === null || busy || !remote.v02ViewerUrl) return;
				setBusy(true);
				setError(false);
				try {
					const result = await remote.v02ViewerUrl(sessionKey, expected.epoch, expected.revision);
					if (generation.current === epoch && revision.current === expected && result?.epoch === expected.epoch && result.revision === expected.revision && (result.expiresAt === null || result.expiresAt > Date.now())) setViewer({
						session: sessionKey,
						source: remote,
						url: result.url,
						expiresAt: result.expiresAt
					});
					else if (generation.current === epoch && revision.current === expected) setError(true);
				} catch {
					if (generation.current === epoch && revision.current === expected) setError(true);
				} finally {
					if (generation.current === epoch) setBusy(false);
				}
			};
			return (0, react_jsx_runtime.jsxs)("section", {
				className: `${panel_module_css_default.section} ${panel_module_css_default.viewerSection}`,
				"aria-busy": busy || view === null && !error,
				children: [(0, react_jsx_runtime.jsxs)("div", {
					className: panel_module_css_default.viewerHead,
					children: [(0, react_jsx_runtime.jsx)("h2", { children: t("desktopTitle") }), currentViewer && (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
						size: "sm",
						onClick: () => {
							setViewer(null);
						},
						children: t("closeViewer")
					})]
				}), view === null ? error ? (0, react_jsx_runtime.jsx)("p", {
					role: "alert",
					className: panel_module_css_default.error,
					children: t("sessionUnavailable")
				}) : (0, react_jsx_runtime.jsx)("div", {
					role: "status",
					"aria-label": t("loading"),
					className: panel_module_css_default.loading,
					children: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.StateDot, {
						state: "ongoing",
						size: 20
					})
				}) : (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [error && (0, react_jsx_runtime.jsx)("p", {
					role: "alert",
					className: panel_module_css_default.error,
					children: t("viewerUnavailable")
				}), currentViewer === null ? (0, react_jsx_runtime.jsxs)("div", {
					className: panel_module_css_default.viewerEmpty,
					children: [
						(0, react_jsx_runtime.jsx)("span", {
							className: panel_module_css_default.emptyIcon,
							"aria-hidden": "true",
							children: (0, react_jsx_runtime.jsx)(WrapvmSectionIcon, {
								size: 24,
								active: false
							})
						}),
						(0, react_jsx_runtime.jsx)("p", { children: view.binding ? t("environmentSelected") : t("noBinding") }),
						(0, react_jsx_runtime.jsx)("p", {
							className: panel_module_css_default.hint,
							children: t("desktopDescription")
						}),
						(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
							variant: "primary",
							onClick: () => {
								open();
							},
							disabled: busy || view.binding === null || !remote.v02ViewerUrl,
							children: busy ? t("loading") : t("viewer")
						})
					]
				}) : (0, react_jsx_runtime.jsx)("iframe", {
					src: currentViewer.url,
					title: t("desktopTitle"),
					className: panel_module_css_default.viewer,
					allow: "clipboard-read; clipboard-write"
				})] })]
			});
		}
		//#endregion
		//#region lib/types/client/session.js
		/** Conversation-specific environment selection and desktop. */
		/** Select an environment for the current conversation. */
		function SessionDesktop({ sessionKey, remote, t }) {
			const [snapshot, setSnapshot] = (0, react.useState)(null);
			const [selected, setSelected] = (0, react.useState)("");
			const [busy, setBusy] = (0, react.useState)(false);
			const [error, setError] = (0, react.useState)(null);
			const generation = (0, react.useRef)(0);
			(0, react.useEffect)(() => {
				const epoch = ++generation.current;
				setSnapshot(null);
				setSelected("");
				setError(null);
				setBusy(false);
				remote.v02Snapshot(sessionKey).then((next) => {
					if (generation.current === epoch) {
						setSnapshot(next);
						setSelected(next.binding?.environmentId ?? "");
					}
				}, (e) => {
					if (generation.current === epoch) setError(e instanceof Error ? e.message : t("failed"));
				});
				return () => {
					generation.current++;
				};
			}, [
				remote,
				sessionKey,
				t
			]);
			const select = async () => {
				if (busy || !remote.v02Bind || !selected) return;
				const epoch = generation.current;
				setBusy(true);
				setError(null);
				try {
					if ((await remote.v02Bind(sessionKey, selected, randomUUID())).state === "failed") throw new Error(t("operationFailed"));
					const next = await remote.v02Snapshot(sessionKey);
					if (generation.current === epoch) setSnapshot(next);
				} catch (e) {
					if (generation.current === epoch) setError(e instanceof Error ? e.message : t("failed"));
				} finally {
					if (generation.current === epoch) setBusy(false);
				}
			};
			const unselect = async () => {
				if (busy || !remote.v02Unbind) return;
				const epoch = generation.current;
				setBusy(true);
				setError(null);
				try {
					await remote.v02Unbind(sessionKey, randomUUID());
					const next = await remote.v02Snapshot(sessionKey);
					if (generation.current === epoch) {
						setSnapshot(next);
						setSelected("");
					}
				} catch (e) {
					if (generation.current === epoch) setError(e instanceof Error ? e.message : t("failed"));
				} finally {
					if (generation.current === epoch) setBusy(false);
				}
			};
			return (0, react_jsx_runtime.jsxs)("div", {
				className: `${panel_module_css_default.section} ${panel_module_css_default.session}`,
				children: [
					error && (0, react_jsx_runtime.jsx)("p", {
						role: "alert",
						className: panel_module_css_default.error,
						children: error
					}),
					(0, react_jsx_runtime.jsxs)("div", {
						className: panel_module_css_default.selector,
						children: [(0, react_jsx_runtime.jsx)("p", {
							className: panel_module_css_default.hint,
							children: t("selectDescription")
						}), snapshot === null ? (0, react_jsx_runtime.jsx)("p", {
							role: "status",
							className: panel_module_css_default.hint,
							children: t("loading")
						}) : (0, react_jsx_runtime.jsx)(react_jsx_runtime.Fragment, { children: snapshot.environments.length === 0 ? (0, react_jsx_runtime.jsx)("p", {
							className: panel_module_css_default.notice,
							children: t("noEnvironments")
						}) : (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [(0, react_jsx_runtime.jsxs)("label", {
							className: panel_module_css_default.field,
							children: [(0, react_jsx_runtime.jsx)("span", { children: t("selectEnvironment") }), (0, react_jsx_runtime.jsxs)("select", {
								className: panel_module_css_default.select,
								value: selected,
								disabled: busy,
								onChange: (e) => {
									setSelected(e.target.value);
								},
								children: [(0, react_jsx_runtime.jsx)("option", {
									value: "",
									children: t("selectEnvironment")
								}), snapshot.environments.map((item) => (0, react_jsx_runtime.jsxs)("option", {
									value: item.id,
									children: [
										item.displayName,
										" · ",
										item.observed?.phase ?? t("unknown")
									]
								}, item.id))]
							})]
						}), (0, react_jsx_runtime.jsxs)("div", {
							className: panel_module_css_default.controls,
							children: [(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
								size: "sm",
								variant: "outline",
								disabled: busy || !selected || !remote.v02Bind || snapshot.binding?.environmentId === selected,
								onClick: () => {
									select();
								},
								children: t("bind")
							}), snapshot.binding && (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
								size: "sm",
								disabled: busy || !remote.v02Unbind,
								onClick: () => {
									unselect();
								},
								children: t("unbind")
							})]
						})] }) })]
					}),
					(0, react_jsx_runtime.jsx)(VmViewer, {
						sessionKey,
						remote,
						t
					}, sessionKey)
				]
			});
		}
		//#endregion
		//#region lib/types/client/panel.js
		/** Use the same conversation controller as the desktop sidebar. */
		function WrapvmSection({ t, useSessions, readRemote }) {
			const session = useSessions((state) => Object.values(state.byId).find((item) => (item.retainedBy.mainView ?? 0) > 0)?.id);
			return (0, react_jsx_runtime.jsxs)("section", {
				className: `${panel_module_css_default.section} ${panel_module_css_default.settings}`,
				children: [(0, react_jsx_runtime.jsxs)("div", { children: [(0, react_jsx_runtime.jsx)("h2", { children: t("title") }), (0, react_jsx_runtime.jsx)("p", {
					className: panel_module_css_default.intro,
					children: t("intro")
				})] }), readRemote && session !== void 0 ? (0, react_jsx_runtime.jsx)(SessionDesktop, {
					sessionKey: session,
					remote: readRemote,
					t
				}, session) : (0, react_jsx_runtime.jsx)("p", { children: t(readRemote ? "noBinding" : "sessionUnavailable") })]
			});
		}
		//#endregion
		//#region lib/types/client/read-inventory.js
		/** Read-only inventory while mutation endpoints are unavailable. */
		/** Render inventory and subscribe to the host sampler without starting environments. */
		function ReadInventory({ remote, t }) {
			const [items, setItems] = (0, react.useState)(null);
			const [error, setError] = (0, react.useState)(false);
			const [attempt, setAttempt] = (0, react.useState)(0);
			(0, react.useEffect)(() => {
				let active = true;
				setError(false);
				remote.v02Snapshot(null).then((snapshot) => {
					if (active) setItems(snapshot.environments);
				}, () => {
					if (active) setError(true);
				});
				return () => {
					active = false;
				};
			}, [remote, attempt]);
			const ids = items?.map((item) => item.id).sort().join("\0") ?? "";
			(0, react.useEffect)(() => {
				if (!ids || !remote.v02WatchResources) return;
				let active = true;
				let stream;
				(async () => {
					try {
						stream = remote.v02WatchResources(ids.split("\0"));
						for await (const update of stream) {
							if (!active) break;
							setItems((current) => current?.map((item) => item.id === update.environmentId ? {
								...item,
								resources: update.resources
							} : item) ?? current);
						}
					} catch {
						if (active) setError(true);
					} finally {
						if (active) setItems((current) => current?.map((item) => item.resources ? {
							...item,
							resources: {
								...item.resources,
								stale: true
							}
						} : item) ?? current);
					}
				})();
				return () => {
					active = false;
					stream?.dispose();
				};
			}, [
				ids,
				remote,
				attempt
			]);
			const number = (value) => value == null ? "—" : String(value);
			return (0, react_jsx_runtime.jsxs)("main", {
				className: panel_module_css_default.section,
				children: [
					(0, react_jsx_runtime.jsx)("h1", { children: t("environments") }),
					(0, react_jsx_runtime.jsx)("p", { children: t("dockerNotice") }),
					(0, react_jsx_runtime.jsx)("p", { children: t("actionsPendingIntegration") }),
					error && (0, react_jsx_runtime.jsx)("p", {
						role: "alert",
						children: t("resourceStreamFailed")
					}),
					(0, react_jsx_runtime.jsx)("button", {
						type: "button",
						onClick: () => {
							setAttempt((value) => value + 1);
						},
						children: t("refresh")
					}),
					items === null ? !error && (0, react_jsx_runtime.jsx)("p", {
						role: "status",
						children: t("loading")
					}) : (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [(0, react_jsx_runtime.jsxs)("p", { children: [
						t("managedCount"),
						": ",
						items.length,
						" · ",
						t("activeCount"),
						": ",
						items.some((item) => item.observed === null) ? "—" : items.filter((item) => item.observed?.phase === "running").length
					] }), items.map((item) => (0, react_jsx_runtime.jsxs)("article", {
						className: panel_module_css_default.section,
						children: [
							(0, react_jsx_runtime.jsx)("h2", { children: item.displayName }),
							(0, react_jsx_runtime.jsxs)("p", { children: [
								item.backend,
								" · ",
								item.observed?.phase ?? t("unknown")
							] }),
							item.uncertainty && (0, react_jsx_runtime.jsxs)("p", {
								role: "alert",
								children: [
									t("outcomeUnknown"),
									": ",
									item.uncertainty
								]
							}),
							(0, react_jsx_runtime.jsxs)("p", { children: [
								t("users"),
								": ",
								!item.bindingsComplete ? t("usersUnknown") : item.bindings.map((binding) => binding.sessionKey).join(", ") || t("none")
							] }),
							(0, react_jsx_runtime.jsxs)("p", { children: [
								t("resources"),
								": CPU ",
								number(item.resources?.cpuPercent),
								"% · ",
								t("memory"),
								": ",
								number(item.resources?.memoryUsedBytes),
								" / ",
								number(item.resources?.memoryLimitBytes),
								" · ",
								t("disk"),
								": ",
								number(item.resources?.writableLayerBytes),
								" + ",
								number(item.resources?.volumeUsedBytes),
								" ",
								item.resources?.stale ? `(${t("stale")})` : ""
							] }),
							(0, react_jsx_runtime.jsxs)("p", { children: [
								t("limits"),
								": ",
								item.limits.cpuMillis,
								" mCPU · ",
								item.limits.memoryBytes,
								" B · ",
								number(item.limits.diskBytes),
								" B"
							] }),
							(0, react_jsx_runtime.jsxs)("p", { children: [
								t("mounts"),
								": ",
								item.mounts.map((mount) => `${mount.hostPath} → ${mount.guestPath} (${mount.access})`).join(", ") || t("none")
							] })
						]
					}, item.id))] })
				]
			});
		}
		//#endregion
		//#region lib/types/client/resource-fields.js
		/** Resource inputs display human units; the host continues to receive integers. */
		const GIB = 1024 ** 3;
		/** Format resource measurements without treating an absent measurement as zero. */
		function formatBytes(value) {
			if (value == null) return "—";
			if (value < 1024) return `${value} B`;
			const unit = value >= GIB ? GIB : 1024 ** 2;
			return `${Number((value / unit).toFixed(1))} ${unit === GIB ? "GiB" : "MiB"}`;
		}
		/** Parse human units, rejecting fractional bytes and invalid host limits. */
		function parseResourceLimits(cpu, memory, diskBytes = null) {
			const cpuMillis = Number(cpu) * 1e3, memoryBytes = Number(memory) * GIB;
			if (!Number.isSafeInteger(cpuMillis) || cpuMillis <= 0 || !Number.isSafeInteger(memoryBytes) || memoryBytes <= 0) return null;
			return {
				cpuMillis,
				memoryBytes,
				diskBytes
			};
		}
		/** Render paired CPU and memory fields used by create and edit dialogs. */
		function ResourceFields({ cpu, memory, onCpu, onMemory, t }) {
			return (0, react_jsx_runtime.jsxs)("div", {
				className: panel_module_css_default.formRow,
				children: [(0, react_jsx_runtime.jsxs)("label", {
					className: panel_module_css_default.field,
					children: [(0, react_jsx_runtime.jsx)("span", { children: t("cpuCores") }), (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Input, {
						className: panel_module_css_default.input,
						type: "number",
						min: "0.001",
						step: "0.5",
						value: cpu,
						onChange: (event) => {
							onCpu(event.target.value);
						}
					})]
				}), (0, react_jsx_runtime.jsxs)("label", {
					className: panel_module_css_default.field,
					children: [(0, react_jsx_runtime.jsx)("span", { children: t("memoryGiB") }), (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Input, {
						className: panel_module_css_default.input,
						type: "number",
						min: "0.125",
						step: "0.5",
						value: memory,
						onChange: (event) => {
							onMemory(event.target.value);
						}
					})]
				})]
			});
		}
		//#endregion
		//#region lib/types/client/environments.js
		/** Inventory and explicit lifecycle controls for managed environments. */
		const key = () => randomUUID();
		const number = (value) => value == null ? "—" : String(value);
		/** List environments without starting any of them. */
		function Environments({ remote, t }) {
			const imageHintId = (0, react.useId)();
			const required = (method) => {
				if (method === void 0) throw new Error(t("actionsPendingIntegration"));
				return method;
			};
			const [items, setItems] = (0, react.useState)(null);
			const [error, setError] = (0, react.useState)(null);
			const [busy, setBusy] = (0, react.useState)(false);
			const [preview, setPreview] = (0, react.useState)(null);
			const [deleting, setDeleting] = (0, react.useState)(false);
			const [name, setName] = (0, react.useState)("");
			const [image, setImage] = (0, react.useState)("");
			const [cpu, setCpu] = (0, react.useState)("1");
			const [memory, setMemory] = (0, react.useState)("1");
			const [creating, setCreating] = (0, react.useState)(false);
			const [editing, setEditing] = (0, react.useState)(null);
			const [internet, setInternet] = (0, react.useState)(false);
			const [mountHost, setMountHost] = (0, react.useState)("");
			const [mountGuest, setMountGuest] = (0, react.useState)("");
			const [mountWrite, setMountWrite] = (0, react.useState)(false);
			const refresh = async () => {
				try {
					setItems((await remote.v02Snapshot(null)).environments);
				} catch (e) {
					setError(e instanceof Error ? e.message : t("failed"));
				}
			};
			(0, react.useEffect)(() => {
				let alive = true;
				remote.v02Snapshot(null).then((s) => {
					if (alive) setItems(s.environments);
				}, (e) => {
					if (alive) setError(e instanceof Error ? e.message : t("failed"));
				});
				return () => {
					alive = false;
				};
			}, [remote, t]);
			const ids = items?.map((item) => item.id).sort().join("\0") ?? "";
			(0, react.useEffect)(() => {
				if (!ids || !remote.v02WatchResources) return;
				const lifetime = new AbortController();
				let subscription;
				const watch = remote.v02WatchResources;
				(async () => {
					try {
						subscription = watch(ids.split("\0"));
						for await (const update of subscription) {
							if (lifetime.signal.aborted) break;
							setItems((current) => current?.map((item) => item.id === update.environmentId ? {
								...item,
								resources: update.resources
							} : item) ?? current);
						}
					} catch {
						if (!lifetime.signal.aborted) setError(t("resourceStreamFailed"));
					} finally {
						if (!lifetime.signal.aborted) setItems((current) => current?.map((item) => item.resources === null ? item : {
							...item,
							resources: {
								...item.resources,
								stale: true
							}
						}) ?? current);
					}
				})();
				return () => {
					lifetime.abort();
					subscription?.dispose();
				};
			}, [
				ids,
				remote,
				t
			]);
			const run = async (action) => {
				if (busy) return false;
				setBusy(true);
				setError(null);
				try {
					const result = await action();
					if (typeof result === "object" && result !== null && "state" in result && result.state === "failed") {
						setError("error" in result && typeof result.error === "string" ? result.error : t("operationFailed"));
						await refresh();
						return false;
					}
					await refresh();
					return true;
				} catch (e) {
					setError(e instanceof Error ? e.message : t("failed"));
					return false;
				} finally {
					setBusy(false);
				}
			};
			const limits = parseResourceLimits(cpu, memory);
			const editedLimits = editing && parseResourceLimits(editing.cpu, editing.memory, editing.diskBytes);
			const requestPreview = async (id, volumes) => {
				setBusy(true);
				setError(null);
				try {
					setPreview(await required(remote.v02PreviewRemoval)(id, volumes));
				} catch (e) {
					setError(e instanceof Error ? e.message : t("failed"));
				} finally {
					setBusy(false);
				}
			};
			const newEnvironment = () => {
				setError(null);
				setCreating(true);
			};
			const modalOpen = creating || editing !== null || preview !== null;
			return (0, react_jsx_runtime.jsxs)("main", {
				className: panel_module_css_default.page,
				"aria-busy": busy,
				children: [
					(0, react_jsx_runtime.jsxs)("div", {
						className: panel_module_css_default.content,
						children: [
							(0, react_jsx_runtime.jsxs)("header", {
								className: panel_module_css_default.header,
								children: [(0, react_jsx_runtime.jsxs)("div", {
									className: panel_module_css_default.heading,
									children: [(0, react_jsx_runtime.jsx)("h1", { children: t("environments") }), (0, react_jsx_runtime.jsx)("p", {
										className: panel_module_css_default.intro,
										children: t("dockerNotice")
									})]
								}), (0, react_jsx_runtime.jsxs)("div", {
									className: panel_module_css_default.controls,
									children: [(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
										variant: "outline",
										icon: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconRefreshOutlineRegular, { size: 16 }),
										onClick: () => {
											refresh();
										},
										disabled: busy,
										children: t("refresh")
									}), (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
										variant: "primary",
										icon: (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconPlusOutlineRegular, { size: 16 }),
										onClick: newEnvironment,
										disabled: busy || !remote.v02Create,
										children: t("newEnvironment")
									})]
								})]
							}),
							error && !modalOpen && (0, react_jsx_runtime.jsx)("p", {
								role: "alert",
								className: panel_module_css_default.error,
								children: error
							}),
							items === null ? (0, react_jsx_runtime.jsxs)("div", {
								className: panel_module_css_default.list,
								role: "status",
								"aria-label": t("loading"),
								children: [(0, react_jsx_runtime.jsx)("div", { className: panel_module_css_default.skeleton }), (0, react_jsx_runtime.jsx)("div", { className: panel_module_css_default.skeleton })]
							}) : (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [
								(0, react_jsx_runtime.jsxs)("div", {
									className: panel_module_css_default.summary,
									children: [(0, react_jsx_runtime.jsxs)("span", { children: [(0, react_jsx_runtime.jsx)("strong", { children: items.length }), t("managedCount")] }), (0, react_jsx_runtime.jsxs)("span", { children: [(0, react_jsx_runtime.jsx)("strong", { children: items.some((item) => item.observed === null) ? "—" : items.filter((item) => item.observed?.phase === "running").length }), t("activeCount")] })]
								}),
								items.length === 0 && (0, react_jsx_runtime.jsxs)("div", {
									className: panel_module_css_default.empty,
									children: [
										(0, react_jsx_runtime.jsx)("span", {
											className: panel_module_css_default.emptyIcon,
											"aria-hidden": "true",
											children: (0, react_jsx_runtime.jsx)(WrapvmSectionIcon, {
												size: 24,
												active: false
											})
										}),
										(0, react_jsx_runtime.jsx)("h2", { children: t("emptyTitle") }),
										(0, react_jsx_runtime.jsx)("p", { children: t("emptyDescription") })
									]
								}),
								(0, react_jsx_runtime.jsx)("div", {
									className: panel_module_css_default.list,
									children: items.map((item) => {
										const phase = item.observed?.phase;
										const unavailable = busy || !!item.uncertainty || item.operations.some((op) => op.state === "running" || op.state === "requested");
										return (0, react_jsx_runtime.jsxs)("article", {
											className: panel_module_css_default.card,
											children: [
												(0, react_jsx_runtime.jsxs)("div", {
													className: panel_module_css_default.cardHead,
													children: [(0, react_jsx_runtime.jsxs)("div", {
														className: panel_module_css_default.cardIdentity,
														children: [(0, react_jsx_runtime.jsx)("h2", { children: item.displayName }), (0, react_jsx_runtime.jsx)("p", {
															className: panel_module_css_default.cardImage,
															children: item.image
														})]
													}), (0, react_jsx_runtime.jsxs)("span", {
														className: panel_module_css_default.status,
														children: [(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.StateDot, {
															state: phase === "running" ? "done" : phase === "paused" ? "warning" : "idle",
															size: 8
														}), t(phase === "running" || phase === "paused" || phase === "stopped" ? phase : "unknown")]
													})]
												}),
												item.uncertainty && (0, react_jsx_runtime.jsxs)("p", {
													role: "alert",
													className: panel_module_css_default.error,
													children: [
														t("outcomeUnknown"),
														": ",
														item.uncertainty
													]
												}),
												(0, react_jsx_runtime.jsxs)("dl", {
													className: panel_module_css_default.metrics,
													children: [
														(0, react_jsx_runtime.jsxs)("div", { children: [(0, react_jsx_runtime.jsx)("dt", { children: t("cpu") }), (0, react_jsx_runtime.jsxs)("dd", { children: [
															number(item.resources?.cpuPercent),
															item.resources?.cpuPercent == null ? "" : "%",
															(0, react_jsx_runtime.jsxs)("span", {
																className: panel_module_css_default.metricNote,
																children: [
																	item.limits.cpuMillis / 1e3,
																	" ",
																	t("cpuCores")
																]
															})
														] })] }),
														(0, react_jsx_runtime.jsxs)("div", { children: [(0, react_jsx_runtime.jsx)("dt", { children: t("memory") }), (0, react_jsx_runtime.jsxs)("dd", { children: [formatBytes(item.resources?.memoryUsedBytes), (0, react_jsx_runtime.jsxs)("span", {
															className: panel_module_css_default.metricNote,
															children: ["/ ", formatBytes(item.limits.memoryBytes)]
														})] })] }),
														(0, react_jsx_runtime.jsxs)("div", { children: [(0, react_jsx_runtime.jsx)("dt", { children: t("disk") }), (0, react_jsx_runtime.jsxs)("dd", { children: [formatBytes(item.resources?.writableLayerBytes), (0, react_jsx_runtime.jsxs)("span", {
															className: panel_module_css_default.metricNote,
															children: [
																t("workspaceVolume"),
																": ",
																formatBytes(item.resources?.volumeUsedBytes)
															]
														})] })] })
													]
												}),
												item.resources?.stale && (0, react_jsx_runtime.jsx)("p", {
													className: panel_module_css_default.hint,
													children: t("stale")
												}),
												(0, react_jsx_runtime.jsxs)("div", {
													className: panel_module_css_default.cardFooter,
													children: [(0, react_jsx_runtime.jsxs)("span", {
														className: panel_module_css_default.hint,
														children: [
															t("users"),
															": ",
															item.bindings.length
														]
													}), (0, react_jsx_runtime.jsxs)("div", {
														className: panel_module_css_default.controls,
														children: [
															(phase === "stopped" || phase == null) && (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
																size: "sm",
																variant: "outline",
																disabled: !remote.v02Start || unavailable || phase !== "stopped",
																onClick: () => {
																	run(() => required(remote.v02Start)(item.id, key()));
																},
																children: t("start")
															}),
															phase === "running" && (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
																size: "sm",
																variant: "outline",
																disabled: !remote.v02Pause || unavailable,
																onClick: () => {
																	run(() => required(remote.v02Pause)(item.id, key()));
																},
																children: t("pause")
															}), (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
																size: "sm",
																variant: "outline",
																disabled: !remote.v02Stop || unavailable,
																onClick: () => {
																	run(() => required(remote.v02Stop)(item.id, key()));
																},
																children: t("stop")
															})] }),
															phase === "paused" && (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
																size: "sm",
																variant: "outline",
																disabled: !remote.v02Resume || unavailable,
																onClick: () => {
																	run(() => required(remote.v02Resume)(item.id, key()));
																},
																children: t("resume")
															}),
															(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
																size: "sm",
																disabled: !remote.v02UpdateLimits || unavailable,
																onClick: () => {
																	setError(null);
																	setEditing({
																		id: item.id,
																		name: item.displayName,
																		cpu: String(item.limits.cpuMillis / 1e3),
																		memory: String(item.limits.memoryBytes / 1024 ** 3),
																		diskBytes: item.limits.diskBytes
																	});
																},
																children: t("limits")
															}),
															(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
																size: "sm",
																className: panel_module_css_default.danger,
																disabled: !remote.v02PreviewRemoval || !remote.v02ConfirmRemoval || unavailable,
																onClick: () => {
																	setDeleting(false);
																	requestPreview(item.id, false);
																},
																children: t("remove")
															})
														]
													})]
												}),
												(0, react_jsx_runtime.jsxs)("details", {
													className: panel_module_css_default.details,
													children: [(0, react_jsx_runtime.jsx)("summary", { children: t("details") }), (0, react_jsx_runtime.jsxs)("dl", { children: [
														(0, react_jsx_runtime.jsx)("dt", { children: t("users") }),
														(0, react_jsx_runtime.jsx)("dd", { children: item.bindings.map((binding) => binding.sessionKey).join(", ") || t("none") }),
														(0, react_jsx_runtime.jsx)("dt", { children: t("mounts") }),
														(0, react_jsx_runtime.jsx)("dd", { children: item.mounts.map((mount) => `${mount.hostPath} → ${mount.guestPath} (${mount.access})`).join(", ") || t("none") })
													] })]
												})
											]
										}, item.id);
									})
								})
							] })
						]
					}),
					(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Modal, {
						open: creating,
						onClose: () => {
							if (!busy) setCreating(false);
						},
						title: t("createEnvironment"),
						closeLabel: t("close"),
						description: t("createDescription"),
						className: panel_module_css_default.modal,
						footer: (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
							disabled: busy,
							onClick: () => {
								setCreating(false);
							},
							children: t("cancel")
						}), (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
							variant: "primary",
							disabled: busy || !remote.v02Create || !name.trim() || !image.trim() || !internet || !limits || !!mountHost !== !!mountGuest,
							onClick: () => {
								if (!limits) return;
								run(() => required(remote.v02Create)({
									displayName: name.trim(),
									image: image.trim(),
									limits,
									internetAccess: internet,
									mounts: mountHost && mountGuest ? [{
										hostPath: mountHost,
										guestPath: mountGuest,
										access: mountWrite ? "read-write" : "read-only"
									}] : []
								}, key())).then((success) => {
									if (success) {
										setCreating(false);
										setName("");
									}
								});
							},
							children: busy ? t("loading") : t("createEnvironment")
						})] }),
						children: (0, react_jsx_runtime.jsxs)("div", {
							className: panel_module_css_default.form,
							children: [(0, react_jsx_runtime.jsxs)("fieldset", {
								disabled: busy,
								children: [
									(0, react_jsx_runtime.jsxs)("label", {
										className: panel_module_css_default.field,
										children: [(0, react_jsx_runtime.jsx)("span", { children: t("environmentName") }), (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Input, {
											className: panel_module_css_default.input,
											"data-modal-autofocus": true,
											value: name,
											onChange: (e) => {
												setName(e.target.value);
											}
										})]
									}),
									(0, react_jsx_runtime.jsxs)("div", {
										className: panel_module_css_default.field,
										children: [(0, react_jsx_runtime.jsxs)("label", {
											className: panel_module_css_default.field,
											children: [(0, react_jsx_runtime.jsx)("span", { children: t("image") }), (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Input, {
												className: panel_module_css_default.input,
												"aria-describedby": imageHintId,
												value: image,
												onChange: (e) => {
													setImage(e.target.value);
												}
											})]
										}), (0, react_jsx_runtime.jsx)("p", {
											id: imageHintId,
											className: panel_module_css_default.hint,
											children: t("imageHint")
										})]
									}),
									(0, react_jsx_runtime.jsx)(ResourceFields, {
										cpu,
										memory,
										onCpu: setCpu,
										onMemory: setMemory,
										t
									}),
									(0, react_jsx_runtime.jsxs)("div", {
										className: panel_module_css_default.network,
										children: [(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Checkbox, {
											checked: internet,
											onChange: setInternet,
											label: t("internet")
										}), (0, react_jsx_runtime.jsx)("p", {
											className: panel_module_css_default.hint,
											children: t("networkDescription")
										})]
									}),
									(0, react_jsx_runtime.jsxs)("details", {
										className: panel_module_css_default.details,
										children: [
											(0, react_jsx_runtime.jsx)("summary", { children: t("advanced") }),
											(0, react_jsx_runtime.jsx)("p", {
												className: panel_module_css_default.hint,
												children: t("sharedDescription")
											}),
											(0, react_jsx_runtime.jsxs)("label", {
												className: panel_module_css_default.field,
												children: [(0, react_jsx_runtime.jsx)("span", { children: t("hostPath") }), (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Input, {
													className: panel_module_css_default.input,
													value: mountHost,
													onChange: (e) => {
														setMountHost(e.target.value);
													}
												})]
											}),
											(0, react_jsx_runtime.jsxs)("label", {
												className: panel_module_css_default.field,
												children: [(0, react_jsx_runtime.jsx)("span", { children: t("guestPath") }), (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Input, {
													className: panel_module_css_default.input,
													value: mountGuest,
													onChange: (e) => {
														setMountGuest(e.target.value);
													}
												})]
											}),
											(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Checkbox, {
												checked: mountWrite,
												onChange: setMountWrite,
												label: t("readWrite")
											})
										]
									})
								]
							}), error && (0, react_jsx_runtime.jsx)("p", {
								role: "alert",
								className: panel_module_css_default.error,
								children: error
							})]
						})
					}),
					(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Modal, {
						open: editing !== null,
						onClose: () => {
							if (!busy) setEditing(null);
						},
						title: t("updateLimits"),
						closeLabel: t("close"),
						description: editing?.name ?? "",
						className: panel_module_css_default.modal,
						footer: (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
							disabled: busy,
							onClick: () => {
								setEditing(null);
							},
							children: t("cancel")
						}), (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
							variant: "primary",
							disabled: busy || !editedLimits,
							onClick: () => {
								if (editing && editedLimits) run(() => required(remote.v02UpdateLimits)(editing.id, editedLimits, key())).then((success) => {
									if (success) setEditing(null);
								});
							},
							children: t("save")
						})] }),
						children: editing && (0, react_jsx_runtime.jsxs)("div", {
							className: panel_module_css_default.form,
							children: [
								(0, react_jsx_runtime.jsx)("p", {
									className: panel_module_css_default.hint,
									children: t("limitsDescription")
								}),
								(0, react_jsx_runtime.jsx)("fieldset", {
									disabled: busy,
									children: (0, react_jsx_runtime.jsx)(ResourceFields, {
										cpu: editing.cpu,
										memory: editing.memory,
										onCpu: (cpu) => {
											setEditing({
												...editing,
												cpu
											});
										},
										onMemory: (memory) => {
											setEditing({
												...editing,
												memory
											});
										},
										t
									})
								}),
								error && (0, react_jsx_runtime.jsx)("p", {
									role: "alert",
									className: panel_module_css_default.error,
									children: error
								})
							]
						})
					}),
					(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Modal, {
						open: preview !== null,
						onClose: () => {
							if (!busy) setPreview(null);
						},
						title: t("remove"),
						closeLabel: t("close"),
						description: t("removeDescription"),
						className: panel_module_css_default.modal,
						footer: (0, react_jsx_runtime.jsxs)(react_jsx_runtime.Fragment, { children: [(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
							disabled: busy,
							onClick: () => {
								setPreview(null);
							},
							children: t("cancel")
						}), (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Button, {
							variant: "outline",
							className: panel_module_css_default.danger,
							disabled: !preview || busy || preview.deleteVolumes !== deleting || Date.now() >= preview.expiresAt,
							onClick: () => {
								if (!preview) return;
								const selected = preview;
								run(() => required(remote.v02ConfirmRemoval)(selected.environmentId, selected.confirmToken, selected.deleteVolumes, key())).then((success) => {
									if (success) setPreview(null);
								});
							},
							children: t("confirmRemove")
						})] }),
						children: preview && (0, react_jsx_runtime.jsxs)("div", {
							className: panel_module_css_default.form,
							children: [
								(0, react_jsx_runtime.jsx)("h3", { children: preview.displayName ?? preview.environmentId }),
								(0, react_jsx_runtime.jsxs)("dl", {
									className: panel_module_css_default.facts,
									children: [
										(0, react_jsx_runtime.jsx)("dt", { children: t("workspaceVolume") }),
										(0, react_jsx_runtime.jsx)("dd", { children: preview.volumeName }),
										(0, react_jsx_runtime.jsx)("dt", { children: t("mounts") }),
										(0, react_jsx_runtime.jsx)("dd", { children: preview.hostMounts.join(", ") || t("none") })
									]
								}),
								(0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.Checkbox, {
									checked: deleting,
									disabled: busy,
									onChange: (selected) => {
										setDeleting(selected);
										requestPreview(preview.environmentId, selected);
									},
									label: t("deleteVolumes")
								}),
								(0, react_jsx_runtime.jsxs)("p", {
									className: panel_module_css_default.hint,
									children: [
										t("previewExpires"),
										": ",
										new Date(preview.expiresAt).toLocaleTimeString()
									]
								}),
								error && (0, react_jsx_runtime.jsx)("p", {
									role: "alert",
									className: panel_module_css_default.error,
									children: error
								})
							]
						})
					})
				]
			});
		}
		//#endregion
		//#region lib/types/client/register-v02.js
		const PANEL_ID = "wrapvm-environments";
		const TAB_ID = "@deepseek-ai/dsh-wrapvm-isolate/desktop";
		function Page({ remote, full, t }) {
			return full ? (0, react_jsx_runtime.jsx)(Environments, {
				remote: full,
				t
			}) : remote ? (0, react_jsx_runtime.jsx)(ReadInventory, {
				remote,
				t
			}) : (0, react_jsx_runtime.jsx)("p", {
				role: "status",
				children: t("sessionUnavailable")
			});
		}
		function Desktop({ remote, full, t, sessionId }) {
			return full ? (0, react_jsx_runtime.jsx)(SessionDesktop, {
				sessionKey: sessionId,
				remote: full,
				t
			}) : remote ? (0, react_jsx_runtime.jsx)(VmViewer, {
				sessionKey: sessionId,
				remote,
				t
			}) : (0, react_jsx_runtime.jsx)("p", {
				role: "status",
				children: t("sessionUnavailable")
			});
		}
		/** Register and dispose the inventory and desktop seats with their context. */
		function registerV02Ui(ctx, remote, full) {
			const t = ctx.locale.bind("wrapvm_isolate");
			ctx.effect(() => ctx.sidebarRightTabs.register({
				id: TAB_ID,
				kind: "wrapvm-desktop",
				title: () => t("desktopTitle"),
				guide: [{
					id: "open",
					order: 40,
					title: () => t("desktopTitle")
				}]
			}), "wrapvm-isolate: desktop type");
			ctx.effect(() => ctx.slots.inject("sidebar.right.pane.tab", () => ctx.slots.register({
				name: "sidebar.right.pane.tab",
				key: TAB_ID,
				locale: "wrapvm_isolate",
				inject: () => ({
					remote,
					full
				})
			}, Desktop)), "wrapvm-isolate: desktop");
			ctx.effect(() => ctx.slots.inject("main", () => ctx.slots.register({
				name: "main",
				key: PANEL_ID,
				locale: "wrapvm_isolate",
				inject: () => ({
					remote,
					full
				})
			}, Page)), "wrapvm-isolate: environments");
			ctx.effect(() => ctx.slots.inject("sidebar.panellist", () => ctx.slots.register({
				name: "sidebar.panellist",
				id: PANEL_ID,
				order: 1,
				locale: "wrapvm_isolate",
				label: () => t("environments")
			}, WrapvmSectionIcon)), "wrapvm-isolate: navigation");
		}
		//#endregion
		//#region lib/types/client/remote-adapter.js
		function unwrap(result) {
			if (!result.ok) throw result.error;
			return result.value;
		}
		/** Preserve the generated streams and unwrap unary replies. */
		function adaptReadV02(wire) {
			const result = { v02Snapshot: async (session) => unwrap(await wire.v02Snapshot(session)) };
			if (wire.v02WatchSession) result.v02WatchSession = (session) => wire.v02WatchSession(session);
			if (wire.v02WatchResources) result.v02WatchResources = (ids) => wire.v02WatchResources(ids);
			if (wire.v02ViewerUrl) result.v02ViewerUrl = async (session, epoch, revision) => unwrap(await wire.v02ViewerUrl(session, epoch, revision));
			return result;
		}
		/** Check whether the mounted contribution exposes all four read operations. */
		function hasReadWire(value) {
			return "v02Snapshot" in value && typeof value.v02Snapshot === "function";
		}
		/** Adapt each available management operation independently. */
		function adaptV02(wire) {
			const result = { ...adaptReadV02(wire) };
			if (wire.v02Create) result.v02Create = async (input, key) => unwrap(await wire.v02Create(input, key));
			if (wire.v02Start) result.v02Start = async (id, key) => unwrap(await wire.v02Start(id, key));
			if (wire.v02Stop) result.v02Stop = async (id, key) => unwrap(await wire.v02Stop(id, key));
			if (wire.v02Pause) result.v02Pause = async (id, key) => unwrap(await wire.v02Pause(id, key));
			if (wire.v02Resume) result.v02Resume = async (id, key) => unwrap(await wire.v02Resume(id, key));
			if (wire.v02Bind) result.v02Bind = async (session, id, key) => unwrap(await wire.v02Bind(session, id, key));
			if (wire.v02Unbind) result.v02Unbind = async (session, key) => unwrap(await wire.v02Unbind(session, key));
			if (wire.v02UpdateLimits) result.v02UpdateLimits = async (id, limits, key) => unwrap(await wire.v02UpdateLimits(id, limits, key));
			if (wire.v02PreviewRemoval) result.v02PreviewRemoval = async (id, volumes) => unwrap(await wire.v02PreviewRemoval(id, volumes));
			if (wire.v02ConfirmRemoval) result.v02ConfirmRemoval = async (id, token, volumes, key) => unwrap(await wire.v02ConfirmRemoval(id, token, volumes, key));
			return result;
		}
		//#endregion
		//#region lib/types/client/locales.js
		/** Settings copy and its typed keys. */
		const en = {
			newEnvironment: "New environment",
			emptyTitle: "Your desktops, in one place",
			emptyDescription: "Create an environment, assign it to a conversation, then open its desktop alongside your work.",
			createDescription: "A persistent workspace with a browser and desktop for your VM tools.",
			cpuCores: "CPU cores",
			memoryGiB: "Memory (GiB)",
			cpu: "CPU",
			allocation: "Allocated",
			advanced: "Shared folders",
			sharedDescription: "Optional. Share a specific host folder with this environment.",
			networkDescription: "Required for this desktop backend. Offline environments are not supported.",
			details: "Details",
			workspaceVolume: "Workspace volume",
			network: "Network",
			close: "Close",
			save: "Save changes",
			limitsDescription: "Set the CPU and memory available to this environment.",
			removeDescription: "The container will be removed. Keep its workspace volume to preserve the files inside it.",
			noEnvironments: "Create an environment in VM environments first.",
			selectDescription: "Choose where this conversation’s VM tools run.",
			desktopDescription: "Open the browser and desktop without leaving your conversation.",
			imageHint: "Use an installed desktop image, for example wrapvm-dsh:desktop.",
			paused: "Paused",
			environmentSelected: "VM environment selected",
			selectEnvironment: "Select environment",
			bind: "Assign to conversation",
			unbind: "Remove assignment",
			activate: "Activate protected mode",
			recover: "Recover",
			release: "Release protection",
			releaseConfirm: "Release protection for this conversation?",
			approvals: "File requests",
			approvalsUnavailable: "Approval and one-use execution are not yet connected.",
			hostProofRequired: "Protected mode requires verified isolation from the host control plane.",
			actionsPendingIntegration: "Environment actions are not yet available.",
			viewerPendingIntegration: "The desktop is unavailable until session protection is connected.",
			desktopTitle: "VM desktop",
			sessionUnavailable: "Session access is unavailable.",
			protected: "Protected mode",
			protectedUnavailable: "Protected mode unavailable",
			activating: "Activating",
			normal: "Normal mode",
			releaseRequired: "A new authenticated release is required.",
			noBinding: "No environment assigned.",
			environments: "VM environments",
			dockerNotice: "Environments run in Docker containers.",
			managedCount: "Managed",
			activeCount: "Running",
			users: "Conversations",
			usersUnknown: "Unknown",
			resources: "Resources",
			memory: "Memory",
			disk: "Disk",
			limits: "Limits",
			mounts: "Shared folders",
			none: "None",
			stale: "Stale",
			outcomeUnknown: "Outcome unknown; reconcile before continuing",
			resourceStreamFailed: "Resource updates are unavailable.",
			operationFailed: "The operation failed.",
			pause: "Pause",
			resume: "Resume",
			updateLimits: "Update limits",
			remove: "Remove",
			createEnvironment: "Create environment",
			environmentName: "Name",
			cpuMillis: "CPU (millicores)",
			memoryBytes: "Memory (bytes)",
			diskBytes: "Disk limit (bytes, optional)",
			internet: "Allow internet",
			offlineUnavailable: "Offline desktop environments are not supported on this Docker setup. Enable internet to create an environment.",
			hostPath: "Host folder",
			guestPath: "Guest folder",
			readWrite: "Allow writing",
			legacyId: "Legacy container ID",
			importLegacy: "Import legacy container",
			deleteVolumes: "Delete workspace volume",
			previewExpires: "Confirmation expires",
			confirmRemove: "Confirm removal",
			cancel: "Cancel",
			title: "Wrapvm desktop",
			intro: "Run VM tools in a separate container and open its desktop. Other Harness tools keep their existing access.",
			empty: "Start the container to open its desktop.",
			viewerUnavailable: "The container is running, but its desktop viewer is unavailable. Refresh to retry.",
			status: "State",
			image: "Image",
			container: "Container",
			viewer: "Open desktop",
			closeViewer: "Close desktop",
			viewerClosed: "Open the desktop when you need it.",
			start: "Start",
			stop: "Stop",
			refresh: "Refresh",
			loading: "Loading",
			running: "Running",
			stopped: "Stopped",
			missing: "Not created",
			unknown: "Unavailable",
			failed: "Could not complete the request. Check the container engine, then refresh."
		};
		/** Simplified Chinese settings copy. */
		const zh = {
			newEnvironment: "新建环境",
			emptyTitle: "集中管理你的桌面",
			emptyDescription: "创建环境并分配给会话，即可在工作时打开它的桌面",
			createDescription: "为虚拟机工具提供持久工作区、浏览器和桌面",
			cpuCores: "CPU 核数",
			memoryGiB: "内存（GiB）",
			cpu: "CPU",
			allocation: "已分配",
			advanced: "共享文件夹",
			sharedDescription: "可选：与此环境共享指定的主机文件夹",
			networkDescription: "此桌面后端需要联网，暂不支持离线环境",
			details: "详情",
			workspaceVolume: "工作区卷",
			network: "网络",
			close: "关闭",
			save: "保存更改",
			limitsDescription: "设置此环境可用的 CPU 和内存",
			removeDescription: "容器将被移除。保留工作区卷可保存其中的文件",
			noEnvironments: "请先在虚拟机环境中创建环境",
			selectDescription: "选择此会话的虚拟机工具运行位置",
			desktopDescription: "在会话内打开浏览器和桌面",
			imageHint: "使用已安装的桌面镜像，例如 wrapvm-dsh:desktop",
			paused: "已暂停",
			environmentSelected: "已选择虚拟机环境",
			selectEnvironment: "选择环境",
			bind: "分配给会话",
			unbind: "移除分配",
			activate: "启用受保护模式",
			recover: "恢复",
			release: "解除保护",
			releaseConfirm: "解除此会话的保护？",
			approvals: "文件请求",
			approvalsUnavailable: "审批和一次性执行尚未连接",
			hostProofRequired: "受保护模式需要验证与主机控制平面隔离",
			actionsPendingIntegration: "环境操作尚不可用",
			viewerPendingIntegration: "连接会话保护前桌面不可用",
			desktopTitle: "虚拟机桌面",
			sessionUnavailable: "无法访问会话",
			protected: "受保护模式",
			protectedUnavailable: "受保护模式不可用",
			activating: "正在启用",
			normal: "普通模式",
			releaseRequired: "需要重新进行身份验证以解除保护",
			noBinding: "未分配环境",
			environments: "虚拟机环境",
			dockerNotice: "环境在 Docker 容器中运行",
			managedCount: "受管理",
			activeCount: "运行中",
			users: "会话",
			usersUnknown: "未知",
			resources: "资源",
			memory: "内存",
			disk: "磁盘",
			limits: "限制",
			mounts: "共享文件夹",
			none: "无",
			stale: "数据过期",
			outcomeUnknown: "结果未知；继续前请先协调状态",
			resourceStreamFailed: "资源更新不可用",
			operationFailed: "操作失败",
			pause: "暂停",
			resume: "恢复",
			updateLimits: "更新限制",
			remove: "移除",
			createEnvironment: "创建环境",
			environmentName: "名称",
			cpuMillis: "CPU（毫核）",
			memoryBytes: "内存（字节）",
			diskBytes: "磁盘限制（字节，可选）",
			internet: "允许联网",
			offlineUnavailable: "此 Docker 配置不支持离线桌面环境。请启用联网后再创建环境。",
			hostPath: "主机文件夹",
			guestPath: "客户机文件夹",
			readWrite: "允许写入",
			legacyId: "旧容器 ID",
			importLegacy: "导入旧容器",
			deleteVolumes: "删除工作区卷",
			previewExpires: "确认到期时间",
			confirmRemove: "确认移除",
			cancel: "取消",
			title: "Wrapvm 桌面",
			intro: "在独立容器中运行虚拟机工具并查看桌面。其他 Harness 工具仍保留原有访问权限",
			empty: "启动容器以打开桌面",
			viewerUnavailable: "容器正在运行，但桌面查看器不可用。请刷新重试",
			status: "状态",
			image: "镜像",
			container: "容器",
			viewer: "打开桌面",
			closeViewer: "关闭桌面",
			viewerClosed: "需要时打开桌面",
			start: "启动",
			stop: "停止",
			refresh: "刷新",
			loading: "加载中",
			running: "运行中",
			stopped: "已停止",
			missing: "未创建",
			unknown: "不可用",
			failed: "无法完成请求。请检查容器引擎，然后刷新"
		};
		//#endregion
		//#region lib/types/client/index.js
		/** Loader identity. */
		const name = "wrapvmIsolate";
		/** Required browser services. */
		const inject = [
			"slots",
			"locale",
			"remote"
		];
		/**
		* Mount the Remote descriptors before registering the settings controls.
		* @param ctx - client plugin context.
		*/
		async function apply(ctx) {
			await ctx.remote.$mount(TYPERT_REMOTE);
			await ctx.inject(["remote.wrapvmIsolate"], (scope) => {
				const remote = hasReadWire(scope.remote.wrapvmIsolate) ? adaptV02(scope.remote.wrapvmIsolate) : null;
				registerSettings(scope, remote);
				scope.inject(["sidebarRightTabs"], (nested) => {
					registerV02Ui(nested, remote, remote);
				});
			});
		}
		function registerSettings(ctx, readRemote) {
			ctx.effect(() => ctx.locale.register("wrapvm_isolate", {
				en,
				zh
			}), "wrapvm-isolate: locales");
			const t = ctx.locale.bind("wrapvm_isolate");
			ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "wrapvm-isolate",
				order: 5,
				label: () => t("title"),
				locale: "wrapvm_isolate",
				inject: () => ({ readRemote })
			}, WrapvmSection));
			ctx.slots.inject("settings.section.icon", () => ctx.slots.register({
				name: "settings.section.icon",
				id: "wrapvm-isolate"
			}, WrapvmSectionIcon));
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		exports.name = name;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map