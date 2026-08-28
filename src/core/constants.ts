import type { ContractCode, JSONSchemaType } from './types.js'

/**
 * The registry-global key used to recognize {@link ContractError} values across
 * package copies.
 *
 * @remarks
 * The descriptor stores the branded value itself. Recognition compares that
 * identity, so a transparent proxy cannot forward its target's brand as its
 * own. The registry makes the key discoverable; it is a recognition mechanism,
 * not an unforgeable provenance marker.
 */
export const CONTRACT_ERROR_BRAND = Symbol.for('@orkestrel/contract.error')

// === Captured host operations

/**
 * Every host operation this package dispatches through, captured while this
 * module evaluates.
 *
 * @remarks
 * THE answer to a defect class that mutated four times before anyone stated it
 * as a class. A caller can replace a global constructor, a static, a prototype
 * member, or a symbol-keyed hook, and each replacement can fail in two ways: it
 * can THROW, which a boundary contains, or it can LIE, which no boundary can
 * see. `Object.freeze = (value) => value` is the second kind and it is the
 * worse one: every cloner succeeds, publishes a mutable graph, and the caller
 * cannot tell that the package's central guarantee evaporated.
 *
 * Containment cannot close that, because there is nothing to contain — only
 * capture can, and only capture taken while this module evaluates. A module's
 * initializers run at import, so a reference read here is whatever was
 * installed at the moment THIS module evaluated, and reading it later, at the
 * call site, is reading whatever the caller most recently installed. "Before any
 * caller code runs" is the tempting phrasing and it is false in exactly the case
 * the limit below names, so it is not used.
 *
 * The limit that follows, stated as a limit rather than as a guarantee: capture
 * is only as early as this package's own evaluation. A consumer module that
 * evaluates BEFORE `@orkestrel/contract` — ESM evaluates imports in source
 * order — chooses what this table captures, and no mechanism inside the package
 * can reach code that ran before the package existed. That precondition is
 * outside this package's control, and an adversary who holds it can replace the
 * package wholesale rather than bother with the table, so it is named here
 * instead of defended.
 *
 * Membership rule, stated so a reviewer can apply it and a new call site knows
 * where to go: **every host operation this package dispatches by name whose
 * result a published answer depends on.** That admits statics, constructors and
 * namespaces, and — this is the part the earlier wording got wrong by writing
 * the rule from the rows instead of the rows from the rule — it admits a
 * PROTOTYPE member on the same terms, including an ACCESSOR's getter,
 * dispatched onto the package's own receiver through {@link INTRINSICS.apply}.
 * A round that read `Object.getOwnPropertyDescriptor(RegExp.prototype, 'source')`
 * per call had captured nothing: capture is decided by WHEN the reference is
 * taken, not by which reflective spelling takes it.
 *
 * Collection membership was previously excluded on the grounds that it needs a
 * data structure rather than one operation, and the exclusion was answered with
 * an exported class whose `has` method every consumer could rewrite — which
 * reproduced the whole defect one prototype higher. The rule has no exception
 * for it: `Set.prototype.has` / `.add` / `.forEach`,
 * `Map.prototype.has` / `.forEach`, and
 * `WeakSet.prototype.has` / `.add` / `.delete` are ordinary rows here, dispatched
 * onto collections this package built and no caller holds, and every membership
 * and visitation answer in the package is asked through the module-scope
 * functions {@link matchesMember} / {@link admitMember} /
 * {@link matchesVisited} / {@link admitVisited} / {@link omitVisited}. A module
 * binding is not a property, so there is no member on that path to replace.
 *
 * The walk-collection exclusion the earlier wording carried — "a redirect
 * corrupts it inside a boundary and the door refuses, which is loud" — was
 * false in the direction the corpus itself installs. `WeakSet.prototype.has`
 * answering `false` does not make a cyclic clone refuse; it removes the
 * termination bound, and a door that never returns is the one failure no
 * boundary can report. Visitation state is captured here for that reason.
 *
 * @example
 * ```ts
 * INTRINSICS.freeze(snapshot) // the genuine Object.freeze, whatever the caller installed
 * ```
 */
export const INTRINSICS = Object.freeze({
	/** `Object.freeze` — the operation the ownership guarantee is made of. */
	freeze: Object.freeze,
	/** `Object.isFrozen` — the independent check that the guarantee actually held. */
	frozen: Object.isFrozen,
	/** `Object.keys` — the own enumerable string-key population of a snapshot. */
	keys: Object.keys,
	/** `Object.values` — the own enumerable value population of a snapshot. */
	values: Object.values,
	/** `Object.hasOwn` — own presence, so no read leaves a container for its prototype. */
	own: Object.hasOwn,
	/** `Object.is` — `SameValue`, so a `NaN` or signed-zero comparison stays exact. */
	same: Object.is,
	/** `Object.create` — the null-prototype and prototype-pinned accumulators. */
	create: Object.create,
	/** `Object.getOwnPropertyDescriptor` — value observation that runs no accessor. */
	describe: Object.getOwnPropertyDescriptor,
	/** `Object.defineProperty` — exact placement of an own data property. */
	define: Object.defineProperty,
	/** `Object.getPrototypeOf` — the record-brand observation. */
	prototype: Object.getPrototypeOf,
	/** `Object.getOwnPropertySymbols` — the own-symbol population. */
	symbols: Object.getOwnPropertySymbols,
	/** `Object.prototype` — the realm-local plain-record prototype identity. */
	base: Object.prototype,
	/** `Reflect.get` — a proxy-visible read that reports the trap's exact answer. */
	read: Reflect.get,
	/** `Reflect.set` — a proxy-visible write. */
	write: Reflect.set,
	/** `Reflect.ownKeys` — the complete own-key population, strings and symbols. */
	members: Reflect.ownKeys,
	/** `Reflect.has` — a proxy-visible presence observation. */
	present: Reflect.has,
	/** `Reflect.getOwnPropertyDescriptor` — the reflective descriptor observation. */
	reveal: Reflect.getOwnPropertyDescriptor,
	/** `Reflect.defineProperty` — placement that answers instead of throwing. */
	declare: Reflect.defineProperty,
	/** `Reflect.getPrototypeOf` — the reflective prototype observation. */
	parent: Reflect.getPrototypeOf,
	/** `Reflect.apply` — dispatch of a captured method onto its receiver. */
	apply: Reflect.apply,
	/** `Reflect.construct` — construction with an explicit new target. */
	construct: Reflect.construct,
	/** `Number.isFinite` — the finite-bound test every numeric shape refuses on. */
	finite: Number.isFinite,
	/** `Number.isInteger` — the integer-budget test the inference caps refuse on. */
	integer: Number.isInteger,
	/** `Number.isSafeInteger` — the safe-integer test every length bound refuses on. */
	safe: Number.isSafeInteger,
	/** `Number.isNaN` — the calendar-validity test for a parsed instant. */
	nan: Number.isNaN,
	/** `Array.isArray` — array identity across realms. */
	array: Array.isArray,
	/** `JSON.stringify` — the escaping used by previews and canonical text. */
	stringify: JSON.stringify,
	/** `JSON.parse` — document decoding. */
	decode: JSON.parse,
	/** `Math.floor` — index and quantity flooring. */
	floor: Math.floor,
	/** `Math.ceil` — index and quantity ceiling. */
	ceil: Math.ceil,
	/** `Math.max` — bound selection. */
	max: Math.max,
	/** `Math.min` — bound selection. */
	min: Math.min,
	/** `Math.imul` — the seeded generator's mixing step. */
	imul: Math.imul,
	/** `String` — primitive text coercion. */
	text: String,
	/** `Number` — primitive numeric coercion. */
	numeric: Number,
	/** `RegExp` — pattern construction from captured source and flags. */
	pattern: RegExp,
	/**
	 * `RegExp.prototype.exec` — THE pattern membership answer, dispatched through
	 * `apply`.
	 *
	 * @remarks
	 * `test` is deliberately absent. `RegExp.prototype.test` is spec-defined in
	 * terms of `RegExpExec`, which re-reads `exec` OFF THE RECEIVER and calls it
	 * when it is callable, so capturing `test` and dispatching it still asks
	 * whatever the caller installed on `RegExp.prototype.exec`. Only
	 * `RegExp.prototype.exec` itself is `RegExpBuiltinExec`, which reads the
	 * pattern's internal slots and no member at all. A capture that still routes
	 * through the replaced member is not a capture.
	 */
	captures: RegExp.prototype.exec,
	/** The `RegExp.prototype.source` getter — the pattern text a published schema embeds, dispatched through `apply`. */
	expression: Object.getOwnPropertyDescriptor(RegExp.prototype, 'source')?.get,
	/** The `RegExp.prototype.flags` getter — the flag text an owned pattern is rebuilt from, dispatched through `apply`. */
	modifiers: Object.getOwnPropertyDescriptor(RegExp.prototype, 'flags')?.get,
	/** `Array` — array construction. */
	list: Array,
	/** `Array.prototype.sort` — the deterministic ordering every published schema is emitted in, dispatched through `apply`. */
	order: Array.prototype.sort,
	/** `Map` — keyed working state. */
	map: Map,
	/** `Map.prototype.get` — a memo read whose answer a published graph embeds, dispatched through `apply`. */
	fetch: Map.prototype.get,
	/** `Map.prototype.set` — a memo write a published graph is later assembled from, dispatched through `apply`. */
	store: Map.prototype.set,
	/** `Map.prototype.has` — a memo presence answer that decides whether a node is captured, dispatched through `apply`. */
	keyed: Map.prototype.has,
	/** `Map.prototype.forEach` — the only full view of a caller's `Map` that runs no iterator, dispatched through `apply`. */
	pairs: Map.prototype.forEach,
	/** `Set` — membership working state. */
	set: Set,
	/** `Set.prototype.has` — THE membership answer every published verdict rests on, dispatched through `apply`. */
	member: Set.prototype.has,
	/** `Set.prototype.add` — collection of one more member, dispatched through `apply`. */
	admit: Set.prototype.add,
	/** `Set.prototype.forEach` — the only full view of a caller's `Set` that runs no iterator, dispatched through `apply`. */
	sweep: Set.prototype.forEach,
	/** `WeakMap` — object-keyed working state. */
	weakMap: WeakMap,
	/** `WeakMap.prototype.get` — an object-keyed memo read a published graph embeds, dispatched through `apply`. */
	recall: WeakMap.prototype.get,
	/** `WeakMap.prototype.set` — an object-keyed memo write, dispatched through `apply`. */
	retain: WeakMap.prototype.set,
	/** `WeakSet` — object-membership working state. */
	weakSet: WeakSet,
	/** `WeakSet.prototype.has` — the visitation answer every traversal's termination rests on, dispatched through `apply`. */
	tracked: WeakSet.prototype.has,
	/** `WeakSet.prototype.add` — entry onto the active path, dispatched through `apply`. */
	track: WeakSet.prototype.add,
	/** `WeakSet.prototype.delete` — exit from the active path, dispatched through `apply`. */
	untrack: WeakSet.prototype.delete,
	/** `Error` — the internal marker an engine throws into its own contained walk. */
	error: Error,
	/** `Date` — calendar validation of an ISO instant. */
	date: Date,
	/** `Date.prototype.getTime` — the calendar verdict a published `format` rests on, dispatched through `apply`. */
	instant: Date.prototype.getTime,
	/** `Date.now` — the wall-clock reading a default generator seed is drawn from. */
	now: Date.now,
})

// JSON-related constants. Kept as plain frozen data so the shipped combinators
// and parsers operate on them directly — there is deliberately no bespoke
// JSON-Schema guard (AGENTS §14 — the deep recursive validators stay out by
// design).

/**
 * The seven standard JSON Schema `type` names, frozen.
 *
 * @remarks
 * The runtime source of truth for the {@link JSONSchemaType} vocabulary. Compose
 * it with the shipped primitives instead of reaching for a bespoke guard:
 * `literalOf(...JSON_SCHEMA_TYPES)` is the guard, and
 * `parseEnum(value, JSON_SCHEMA_TYPES)` / `parseEnumField(record, path, JSON_SCHEMA_TYPES)`
 * is the parser.
 *
 * @example
 * ```ts
 * import { JSON_SCHEMA_TYPES, literalOf, parseEnumField } from '@orkestrel/contract'
 *
 * const isSchemaType = literalOf(...JSON_SCHEMA_TYPES) // Guard<JSONSchemaType>
 * parseEnumField(schema, 'type', JSON_SCHEMA_TYPES)    // JSONSchemaType | undefined
 * ```
 */
export const JSON_SCHEMA_TYPES: readonly JSONSchemaType[] = Object.freeze([
	'null',
	'boolean',
	'object',
	'array',
	'number',
	'integer',
	'string',
])

/**
 * Every declared {@link ContractCode} refusal category, frozen.
 *
 * @remarks
 * The runtime source of truth for the {@link ContractCode} vocabulary, and the
 * one list every membership test over it reads: `readValue` decides from it
 * whether a caller-supplied code is declared, and `isContractError` decides
 * from it whether a candidate error carries a declared one. A code added to the
 * union is added here, so neither test can drift from the type or from the
 * other.
 *
 * @example
 * ```ts
 * import { CONTRACT_CODES, literalOf } from '@orkestrel/contract'
 *
 * const isContractCode = literalOf(...CONTRACT_CODES) // Guard<ContractCode>
 * ```
 */
export const CONTRACT_CODES: readonly ContractCode[] = Object.freeze([
	'bound',
	'range',
	'empty',
	'placement',
	'structure',
	'literal',
	'cycle',
	'pattern',
	'generate',
	'random',
	'clone',
	'depth',
	'expansion',
])

// Reporting-surface bounds (`compileReporter` / `compileAuditor` —
// `ContractInterface.explain` / `ContractInterface.audit`).

/**
 * The maximum number of {@link Fault} / {@link AuditFault} entries a single
 * `explain` or `audit` report ever returns, frozen.
 *
 * @remarks
 * Bounds BOTH reports against adversarial input (a giant array, a wide record)
 * — `compileReporter` and `compileAuditor` each collect faults in stable
 * pre-order and stop once this cap is reached, and every recursive call slices
 * to it, so the report size (and the work to build it) stays finite and
 * deterministic at every nesting level regardless of the input's size. Size a
 * diagnostic surface off this constant and it bounds `audit` exactly as it
 * bounds `explain`.
 */
export const FAULT_LIMIT = 64

/**
 * The maximum character length of a {@link preview}-rendered string, frozen.
 *
 * @remarks
 * A previewed string longer than this is clipped with a trailing `…` so a
 * {@link Fault}'s `received` field never embeds an unbounded amount of
 * untrusted text.
 */
export const PREVIEW_LIMIT = 64

// Runtime recursion and generation bounds.

/**
 * The maximum active recursion or JSON container depth for runtime guards,
 * frozen.
 *
 * @remarks
 * Bounds explicitly recursive guards before the JavaScript call stack becomes
 * the limiting mechanism. It also caps array/plain-record containers on each
 * active path inspected by {@link matchesJSONDepth}: noncontainers are depth
 * zero, an empty container is depth one, 512 containers pass, and the 513th
 * fails. Active cycle edges do not add a level.
 *
 * @example
 * ```ts
 * GUARD_DEPTH_LIMIT // 512
 * ```
 */
export const GUARD_DEPTH_LIMIT = 512

/**
 * The maximum supported nesting depth of a compiled contract shape, frozen.
 *
 * @remarks
 * {@link validateShapeDepth} rejects the next level
 * with a depth-coded {@link ContractError} before recursive artifact
 * compilation begins, so a finite but pathologically deep developer-authored
 * shape fails predictably instead of reaching the JavaScript call-stack limit.
 *
 * @example
 * ```ts
 * COMPILE_DEPTH_LIMIT // 512
 * ```
 */
export const COMPILE_DEPTH_LIMIT = 512

/**
 * The maximum number of nodes a compiled artifact may expand a shape into,
 * frozen.
 *
 * @remarks
 * A shape graph is a DAG; every compiled artifact is a TREE. A declaration may
 * therefore be tiny and its schema, guard, parser, reporter, auditor and
 * generated value enormous: `objectShape({ left: node, right: node })` nested
 * thirty times is thirty-one authored nodes that expand into more than a
 * billion emitted ones. Sharing one child is ordinary authoring, not an attack,
 * and the compilers cannot fold the expansion away without publishing a schema
 * whose members alias each other.
 *
 * So the cost is BOUNDED rather than paid. {@link validateShapeDepth} and
 * {@link ContractCompiler} preparation both count the nodes the declaration
 * expands into (one per node, summed over every incoming edge) and refuse past
 * this cap through {@link refuseExpansion}, with an `expansion`-coded
 * {@link ContractError}. Ownership is deliberately NOT bounded by it:
 * {@link cloneShape} and {@link ownShape} preserve shared-child identity, so
 * they answer a shared-child graph in time proportional to its authored nodes
 * and keep working above this cap.
 *
 * What this cap bounds MOVED when the compilers stopped expanding a DAG. Every
 * artifact family is now one entry per unique node, so the boundary declaration
 * above compiles fourteen nodes in about a millisecond rather than sixteen
 * thousand in 1,342 ms, and the cap is no longer what keeps compilation finite.
 * What still expands is what a CONSUMER materializes from the artifacts: the
 * value `generate` builds, and the document a compiled schema serializes to,
 * are trees of exactly this size. The cap survives as a bound on what a caller
 * can be handed, not on what the compiler pays.
 *
 * @example
 * ```ts
 * COMPILE_NODE_LIMIT // 16384
 * ```
 */
export const COMPILE_NODE_LIMIT = 16_384

/**
 * The maximum number of nodes one JSON snapshot may produce, frozen.
 *
 * @remarks
 * JSON persistence is a TREE, so `cloneJSONValue` / `cloneJSONRecord`
 * deliberately duplicate a repeated noncyclic alias into distinct equal
 * branches — `clone.primary !== clone.fallback` is a documented guarantee, not
 * an accident, and a memo would silently take it away. The price of that
 * guarantee is that output size is exponential in the number of shared aliases:
 * an ordinary in-memory graph of twenty-one objects, a few hundred bytes,
 * produced two million nodes and took seconds, and thirty aliases took hours.
 * No attacker is needed — shared references are normal data.
 *
 * So the cost is BOUNDED rather than paid: the walk counts the nodes it
 * produces and refuses past this cap with the ordinary cause-free `clone`
 * refusal, which makes the door's worst case a function of this constant
 * instead of the caller's input. Size a snapshot against it: a document with
 * more than this many nodes — counting every array, record, and leaf the
 * snapshot would contain AFTER alias duplication — is refused rather than
 * cloned.
 *
 * @example
 * ```ts
 * CLONE_NODE_LIMIT // 262144
 * ```
 */
export const CLONE_NODE_LIMIT = 262_144

/**
 * The maximum number of candidate-generation attempts for a constrained
 * generated value, frozen.
 *
 * @remarks
 * Provides one deterministic work bound for generators that must retry a
 * candidate against a contract constraint.
 *
 * @example
 * ```ts
 * GENERATION_ATTEMPT_LIMIT // 32
 * ```
 */
export const GENERATION_ATTEMPT_LIMIT = 32

// Value-to-schema inference bounds (`valueToSchema` / `samplesToSchema`).

/**
 * The maximum object/array nesting depth {@link valueToSchema} walks, frozen.
 *
 * @remarks
 * Bounds inference against adversarial or cyclic runtime input — once the
 * remaining depth budget reaches zero, inference stops descending and emits
 * the empty accept-anything schema `{}` for that branch instead of recursing
 * further. LOWERABLE per call via {@link ValueToSchemaOptions.maxDepth}; a
 * higher value is held here.
 *
 * A ceiling rather than a default, because the walk recurses: what a deeper
 * walk spends is the JavaScript call stack rather than this budget, and that
 * stack is not a fixed quantity. The survivable depth measured on one host rose
 * across repeated calls within a single process as the engine optimized, and
 * fell to roughly this number under a reduced stack size. Any larger constant
 * therefore has a host where it fails, which is why none is published.
 */
export const INFER_DEPTH_LIMIT = 32

/**
 * The default maximum number of object properties / array elements
 * {@link valueToSchema} samples per container, frozen.
 *
 * @remarks
 * Bounds the work (and the emitted schema's size) against a wide record or a
 * huge array — properties/elements beyond this cap are never inspected.
 * Overridable per call via {@link ValueToSchemaOptions.maxProperties}.
 */
export const INFER_BREADTH_LIMIT = 256

/**
 * The default maximum number of distinct values a multi-sample slot may hold
 * before enum inference gives up and falls back to a bare `type`, frozen.
 *
 * @remarks
 * Bounds how large an `enum` list {@link samplesToSchema} / {@link inferRecordSamples}
 * will emit — a slot with distinct-value count at or above this limit is
 * treated as unbounded (an ID column, not a category) and never gets an
 * `enum` keyword. Overridable per call via {@link ValueToSchemaOptions.enum}
 * (which gates whether enum inference runs at all).
 */
export const INFER_ENUM_LIMIT = 12

/**
 * The maximum string length {@link stringToFormat} attempts to classify,
 * frozen.
 *
 * @remarks
 * Bounds per-string format-detection work: a value longer than this returns
 * `undefined` immediately, before any pattern match runs. 128 sits
 * comfortably above the longest real format token — an RFC 3339 date-time
 * with fractional seconds and a UTC offset — so no legitimate classification
 * changes; only pathologically long strings (a multi-megabyte payload passed
 * as a candidate email/URI) are skipped.
 */
export const FORMAT_MAX_LENGTH = 128

/**
 * Pure-regex matchers backing {@link stringToFormat}'s pattern-only formats
 * (`uuid` / `email` / `uri`), frozen as data.
 *
 * @remarks
 * The ISO-8601 date/time formats are NOT listed here — they additionally
 * require an attempt-guarded `Date` validity check, so their pattern lives
 * inline in `stringToFormat` rather than as reusable standalone data.
 */
export const FORMAT_PATTERNS: Readonly<Record<'uuid' | 'email' | 'uri', RegExp>> = Object.freeze({
	uuid: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
	email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
	uri: /^[a-z][a-z0-9+.-]*:\/\//i,
})
