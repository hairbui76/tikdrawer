"use client";

import { resizeShape, sideToAngle, sizeOf } from "@/lib/geometry";
import { useShapes, useStore } from "@/lib/store";
import {
	SIDES_8,
	type ArrowStyle,
	type Attach,
	type Shape,
	type Side,
} from "@/lib/types";

const ROTATABLE = new Set<Shape["kind"]>([
	"rect",
	"diamond",
	"roundrect",
	"cylinder",
	"ellipse",
	"node",
	"polygon",
	"image",
]);
const TEXTABLE = new Set<Shape["kind"]>([
	"node",
	"rect",
	"diamond",
	"roundrect",
	"cylinder",
	"circle",
	"ellipse",
	"polygon",
]);
const shapeText = (s: Shape): string | undefined =>
	(s as { text?: string }).text;

/** Width/Height inputs with an aspect-ratio lock (chain) toggle. */
function SizeControls({ shape }: { shape: Shape }) {
	const updateShape = useStore((s) => s.updateShape);
	const beginChange = useStore((s) => s.beginChange);
	const lockAspect = useStore((s) => s.lockAspect);
	const setLockAspect = useStore((s) => s.setLockAspect);
	const size = sizeOf(shape);
	if (!size) return null;
	const w = Math.round(size.w);
	const h = Math.round(size.h);
	const apply = (nw: number, nh: number) =>
		updateShape(shape.id, resizeShape(shape, nw, nh));
	const onW = (val: number) => {
		const nw = Math.max(1, val);
		apply(nw, lockAspect && w ? Math.round(nw * (h / w)) : h);
	};
	const onH = (val: number) => {
		const nh = Math.max(1, val);
		apply(lockAspect && h ? Math.round(nh * (w / h)) : w, nh);
	};
	const isCircle = shape.kind === "circle";
	return (
		<div className="flex items-end gap-1.5">
			<label className="flex flex-1 flex-col gap-1">
				<span className="text-slate-600">Width</span>
				<input
					type="number"
					min={1}
					value={w}
					onFocus={() => beginChange()}
					onChange={(e) => onW(Number(e.target.value) || 1)}
					className="w-full rounded border border-slate-300 px-2 py-1"
				/>
			</label>
			<button
				onClick={() => setLockAspect(!lockAspect)}
				title={lockAspect ? "Aspect ratio locked" : "Lock aspect ratio"}
				aria-pressed={lockAspect}
				className={`rounded border px-2 py-1 ${lockAspect ? "border-blue-500 bg-blue-50" : "border-slate-300 bg-white"}`}>
				{lockAspect ? "🔗" : "🔓"}
			</button>
			<label className="flex flex-1 flex-col gap-1">
				<span className="text-slate-600">Height</span>
				<input
					type="number"
					min={1}
					value={h}
					disabled={isCircle}
					onFocus={() => beginChange()}
					onChange={(e) => onH(Number(e.target.value) || 1)}
					className="w-full rounded border border-slate-300 px-2 py-1 disabled:opacity-40"
				/>
			</label>
		</div>
	);
}

const SIDE_OPTIONS: { value: string; label: string }[] = [
	{ value: "auto", label: "Auto" },
	{ value: "n", label: "Top (N)" },
	{ value: "s", label: "Bottom (S)" },
	{ value: "e", label: "Right (E)" },
	{ value: "w", label: "Left (W)" },
	{ value: "ne", label: "Top-right (NE)" },
	{ value: "nw", label: "Top-left (NW)" },
	{ value: "se", label: "Bottom-right (SE)" },
	{ value: "sw", label: "Bottom-left (SW)" },
];

/** Map a stored attach value to a dropdown value ("auto", a side, or "custom"). */
function attachToValue(a: Attach): string {
	if (typeof a !== "number") return "auto";
	return SIDES_8.find((s) => Math.abs(sideToAngle(s) - a) < 1e-6) ?? "custom";
}

function valueToAttach(v: string): Attach {
	return v === "auto" || v === "custom" ? "auto" : sideToAngle(v as Side);
}

export function PropertiesPanel() {
	const selectedIds = useStore((s) => s.selectedIds);
	const shapes = useShapes();
	const updateShapeStyle = useStore((s) => s.updateShapeStyle);
	const updateShape = useStore((s) => s.updateShape);
	const deleteShape = useStore((s) => s.deleteShape);
	const deleteSelected = useStore((s) => s.deleteSelected);
	const groupSelectionAsTemplate = useStore((s) => s.groupSelectionAsTemplate);
	const beginChange = useStore((s) => s.beginChange);

	// Multi-selection: offer grouping into a reusable symbol + delete.
	if (selectedIds.length > 1) {
		return (
			<div className="flex flex-col gap-3 text-sm">
				<h2 className="px-1 text-xs font-semibold uppercase tracking-wide text-slate-400">
					{selectedIds.length} shapes selected
				</h2>
				<button
					onClick={() => {
						const name = window.prompt("Symbol name:", "My symbol");
						if (name) groupSelectionAsTemplate(name);
					}}
					className="rounded bg-blue-600 px-2 py-1 text-white hover:bg-blue-700">
					Group as symbol
				</button>
				<button
					onClick={() => deleteSelected()}
					className="rounded border border-red-300 bg-white px-2 py-1 text-red-600 hover:bg-red-50">
					Delete selection
				</button>
				<p className="px-1 text-xs text-slate-400">
					Saved symbols appear in the Template dropdown — use “Add to canvas”.
				</p>
			</div>
		);
	}

	const shape =
		selectedIds.length === 1
			? shapes.find((s) => s.id === selectedIds[0])
			: undefined;

	if (!shape) {
		return (
			<div className="px-1 text-xs text-slate-400">
				Select a shape to edit it. Drag on empty canvas to box-select;
				Shift-click to add/remove.
			</div>
		);
	}

	// Images get their own minimal panel (size / opacity / rotation).
	if (shape.kind === "image") {
		return (
			<div className="flex flex-col gap-3 text-sm">
				<h2 className="px-1 text-xs font-semibold uppercase tracking-wide text-slate-400">
					Properties · image
				</h2>
				<SizeControls shape={shape} />
				<label className="flex flex-col gap-1">
					<span className="text-slate-600">
						Opacity · {shape.style.opacity.toFixed(2)}
					</span>
					<input
						type="range"
						min={0}
						max={1}
						step={0.05}
						value={shape.style.opacity}
						onFocus={() => beginChange()}
						onChange={(e) =>
							updateShapeStyle(shape.id, { opacity: Number(e.target.value) })
						}
					/>
				</label>
				<label className="flex items-center justify-between gap-2">
					<span className="text-slate-600">Rotation°</span>
					<input
						type="number"
						step={5}
						value={Math.round(shape.rotation ?? 0)}
						onFocus={() => beginChange()}
						onChange={(e) =>
							updateShape(shape.id, {
								rotation: (((Number(e.target.value) || 0) % 360) + 360) % 360,
							})
						}
						className="w-20 rounded border border-slate-300 px-2 py-1"
					/>
				</label>
				<button
					onClick={() => deleteShape(shape.id)}
					className="mt-1 rounded border border-red-300 bg-white px-2 py-1 text-red-600 hover:bg-red-50">
					Delete image
				</button>
			</div>
		);
	}

	const st = shape.style;
	const hasFill = st.fill !== "none";
	const isConnector = shape.kind === "connector";
	const hasArrow = shape.kind === "line" || isConnector;

	return (
		<div className="flex flex-col gap-3 text-sm">
			<h2 className="px-1 text-xs font-semibold uppercase tracking-wide text-slate-400">
				Properties · {shape.kind}
			</h2>

			{sizeOf(shape) && <SizeControls shape={shape} />}

			{TEXTABLE.has(shape.kind) && (
				<label className="flex flex-col gap-1">
					<span className="text-slate-600">Text</span>
					<input
						type="text"
						value={shapeText(shape) ?? ""}
						onFocus={() => beginChange()}
						onChange={(e) => updateShape(shape.id, { text: e.target.value })}
						className="rounded border border-slate-300 px-2 py-1"
						placeholder="(double-click shape too)"
					/>
				</label>
			)}

			<label className="flex items-center justify-between gap-2">
				<span className="text-slate-600">Stroke</span>
				<input
					type="color"
					value={st.stroke}
					onFocus={() => beginChange()}
					onChange={(e) =>
						updateShapeStyle(shape.id, { stroke: e.target.value })
					}
					className="h-7 w-10 cursor-pointer rounded border border-slate-300"
				/>
			</label>

			{!isConnector && (
				<label className="flex items-center justify-between gap-2">
					<span className="text-slate-600">Fill</span>
					<span className="flex items-center gap-2">
						<input
							type="checkbox"
							checked={hasFill}
							onChange={(e) => {
								beginChange();
								updateShapeStyle(shape.id, {
									fill: e.target.checked ? "#93c5fd" : "none",
								});
							}}
						/>
						<input
							type="color"
							disabled={!hasFill}
							value={hasFill ? st.fill : "#93c5fd"}
							onFocus={() => beginChange()}
							onChange={(e) =>
								updateShapeStyle(shape.id, { fill: e.target.value })
							}
							className="h-7 w-10 cursor-pointer rounded border border-slate-300 disabled:opacity-40"
						/>
					</span>
				</label>
			)}

			<label className="flex items-center justify-between gap-2">
				<span className="text-slate-600">Line width</span>
				<input
					type="number"
					min={0.2}
					step={0.2}
					value={st.lineWidth}
					onFocus={() => beginChange()}
					onChange={(e) =>
						updateShapeStyle(shape.id, {
							lineWidth: Number(e.target.value) || 0.4,
						})
					}
					className="w-20 rounded border border-slate-300 px-2 py-1"
				/>
			</label>

			<label className="flex items-center justify-between gap-2">
				<span className="text-slate-600">Dashed</span>
				<input
					type="checkbox"
					checked={st.dashed}
					onChange={(e) => {
						beginChange();
						updateShapeStyle(shape.id, { dashed: e.target.checked });
					}}
				/>
			</label>

			{hasArrow && (
				<label className="flex items-center justify-between gap-2">
					<span className="text-slate-600">Arrow</span>
					<select
						value={st.arrow}
						onChange={(e) => {
							beginChange();
							updateShapeStyle(shape.id, {
								arrow: e.target.value as ArrowStyle,
							});
						}}
						className="rounded border border-slate-300 px-2 py-1">
						<option value="none">none</option>
						<option value="->">→ end</option>
						<option value="<-">← start</option>
						<option value="<->">↔ both</option>
					</select>
				</label>
			)}

			<label className="flex flex-col gap-1">
				<span className="text-slate-600">
					Opacity · {st.opacity.toFixed(2)}
				</span>
				<input
					type="range"
					min={0}
					max={1}
					step={0.05}
					value={st.opacity}
					onFocus={() => beginChange()}
					onChange={(e) =>
						updateShapeStyle(shape.id, { opacity: Number(e.target.value) })
					}
				/>
			</label>

			{ROTATABLE.has(shape.kind) && (
				<label className="flex items-center justify-between gap-2">
					<span className="text-slate-600">Rotation°</span>
					<input
						type="number"
						step={5}
						value={Math.round((shape as { rotation?: number }).rotation ?? 0)}
						onFocus={() => beginChange()}
						onChange={(e) =>
							updateShape(shape.id, {
								rotation: (((Number(e.target.value) || 0) % 360) + 360) % 360,
							})
						}
						className="w-20 rounded border border-slate-300 px-2 py-1"
					/>
				</label>
			)}

			{shape.kind === "connector" && (
				<>
					<label className="flex items-center justify-between gap-2">
						<span className="text-slate-600">From side</span>
						<select
							value={attachToValue(shape.from.attach)}
							disabled={!shape.from.anchor}
							onChange={(e) => {
								beginChange();
								updateShape(shape.id, {
									from: {
										...shape.from,
										attach: valueToAttach(e.target.value),
									},
								});
							}}
							className="rounded border border-slate-300 px-2 py-1 disabled:opacity-40">
							{SIDE_OPTIONS.map((o) => (
								<option key={o.value} value={o.value}>
									{o.label}
								</option>
							))}
							{attachToValue(shape.from.attach) === "custom" && (
								<option value="custom">Custom (free)</option>
							)}
						</select>
					</label>

					<label className="flex items-center justify-between gap-2">
						<span className="text-slate-600">To side</span>
						<select
							value={attachToValue(shape.to.attach)}
							disabled={!shape.to.anchor}
							onChange={(e) => {
								beginChange();
								updateShape(shape.id, {
									to: { ...shape.to, attach: valueToAttach(e.target.value) },
								});
							}}
							className="rounded border border-slate-300 px-2 py-1 disabled:opacity-40">
							{SIDE_OPTIONS.map((o) => (
								<option key={o.value} value={o.value}>
									{o.label}
								</option>
							))}
							{attachToValue(shape.to.attach) === "custom" && (
								<option value="custom">Custom (free)</option>
							)}
						</select>
					</label>

					{shape.curved && (
						<button
							onClick={() => {
								beginChange();
								updateShape(shape.id, { curved: false });
							}}
							className="rounded border border-slate-300 bg-white px-2 py-1 hover:bg-slate-100">
							Straighten curve
						</button>
					)}

					<p className="px-1 text-xs text-slate-400">
						Drag the blue dot on the line to bend it.
					</p>
				</>
			)}

			<button
				onClick={() => deleteShape(shape.id)}
				className="mt-1 rounded border border-red-300 bg-white px-2 py-1 text-red-600 hover:bg-red-50">
				Delete shape
			</button>
		</div>
	);
}
