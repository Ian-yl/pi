import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  BadgePercent,
  Box,
  Camera,
  ChevronDown,
  ChevronRight,
  Clock3,
  Download,
  FileImage,
  FileText,
  Flame,
  GalleryHorizontal,
  Image,
  Languages,
  LayoutGrid,
  List,
  Loader2,
  Megaphone,
  Minus,
  Package,
  Palette,
  Plus,
  RefreshCw,
  ScanLine,
  Settings,
  Shirt,
  ShoppingBag,
  Sparkles,
  Trash2,
  Upload,
  UserRound,
  WandSparkles,
  X,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import {
  aiAssistCopy,
  generateImages,
  generateMatchedModel,
  loadHistory,
  loadPage,
} from "../data/apiClient.js";
import { fileToPreview, makeImage } from "../data/imageFactory.js";

const iconMap = {
  bag: ShoppingBag,
  shirt: Shirt,
  megaphone: Megaphone,
  panels: GalleryHorizontal,
  file: FileText,
  image: Image,
  flame: Flame,
  box: Box,
  user: UserRound,
  sprout: Sparkles,
  layers: LayoutGrid,
  translate: Languages,
  square: ScanLine,
  cube: Package,
  clock: Clock3,
  settings: Settings,
  palette: Palette,
  badge: BadgePercent,
  list: List,
  layoutgrid: LayoutGrid,
  filetext: FileText,
  shoppingbag: ShoppingBag,
  userround: UserRound,
  panelstopleft: GalleryHorizontal,
  grid3x3: LayoutGrid,
  listfilter: List,
  columns2: LayoutGrid,
  columns3: LayoutGrid,
  layers3: LayoutGrid,
  slidershorizontal: Settings,
  badgedollarsign: BadgePercent,
  badgepercent: BadgePercent,
  calendarheart: Clock3,
  paneltop: GalleryHorizontal,
  messagessquare: FileText,
  clock3: Clock3,
  history: Clock3,
  boxes: Package,
  images: Image,
  badge3d: Package,
  search: ScanLine,
  flower2: Sparkles,
  badgecheck: BadgePercent,
  userroundcog: UserRound,
  personstanding: UserRound,
  footprints: Package,
  scanface: ScanLine,
  store: ShoppingBag,
  notebooktabs: FileText,
  tag: FileText,
  type: FileText,
  messagecircle: FileText,
  leaf: Sparkles,
  truck: Package,
  shieldcheck: BadgePercent,
  ruler: ScanLine,
  video: GalleryHorizontal,
};

function Icon({ name, size = 20 }) {
  const key = String(name ?? "")
    .replace(/[^a-zA-Z0-9]/g, "")
    .toLowerCase();
  const Component = iconMap[key] ?? iconMap[name] ?? FileImage;
  return <Component size={size} strokeWidth={1.8} />;
}

function optionValue(option) {
  if (option && typeof option === "object")
    return option.value ?? option.id ?? option.label;
  return option;
}

function optionLabel(option) {
  if (option && typeof option === "object")
    return option.label ?? option.value ?? option.id;
  return option;
}

function optionKey(option) {
  return String(optionValue(option));
}

function sectionKey(section, fallback) {
  return section.id ?? section.field ?? `${section.type}-${fallback}`;
}

function isHistoryMenuItem(menuItem) {
  return (
    menuItem?.history ||
    menuItem?.id === "history" ||
    menuItem?.label === "我的生成记录"
  );
}

function numberedSections(sections = []) {
  let counter = 0;
  return sections.map((section) => {
    if (
      [
        "upload",
        "textarea",
        "modelReference",
        "chipsEditable",
        "choiceTags",
        "layoutChoices",
        "colorTheme",
        "paramsTable",
        "ratioGrid",
        "stepper",
        "select",
      ].includes(section.type)
    ) {
      counter += 1;
      return { ...section, index: section.index ?? counter };
    }
    return section;
  });
}

function createSeedUploads(config) {
  return Object.fromEntries(
    (config.uploadSlots ?? []).map((slot) => [
      slot.id,
      (slot.seedLabels ?? []).map((label, index) => ({
        id: `${slot.id}-seed-${index}`,
        name: label,
        label,
        url: makeImage(config.imageKind, label, "thumb"),
        source: "seed",
      })),
    ]),
  );
}

function createInitialValues(config) {
  const defaults = config.defaults ?? {};
  return {
    ...defaults,
    count: defaults.count ?? 4,
    ratio: defaults.ratio ?? "1:1",
    resolution: defaults.resolution ?? "1024px",
  };
}

function getAllUploadFiles(uploads) {
  return Object.values(uploads)
    .flat()
    .filter((item) => item.file)
    .map((item) => item.file);
}

function getGenerationFiles(uploads, values, sections = []) {
  const modelReferenceFiles = sections
    .filter((section) => section.type === "modelReference")
    .map((section) => values[section.field]?.file)
    .filter(Boolean);
  return [...getAllUploadFiles(uploads), ...modelReferenceFiles];
}

function serializeGenerationValue(value) {
  if (Array.isArray(value)) return value.map(serializeGenerationValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key]) => key !== "file")
        .map(([key, nextValue]) => [key, serializeGenerationValue(nextValue)]),
    );
  }
  return value;
}

function serializeGenerationValues(values) {
  return Object.fromEntries(
    Object.entries(values).map(([key, value]) => [
      key,
      serializeGenerationValue(value),
    ]),
  );
}

function pillClass(active) {
  return active ? "choice-pill active" : "choice-pill";
}

function FieldNumber({ index, title, required, inlineAction }) {
  return (
    <div className="section-title-row">
      <h3>
        {index ? `${index}. ` : ""}
        {title}
        {required ? <span>（必填）</span> : null}
      </h3>
      {inlineAction}
    </div>
  );
}

function UploadStrip({ config, slot, items, onFiles, onRemove, inputRef }) {
  const [dragging, setDragging] = useState(false);

  function handleDrop(event) {
    event.preventDefault();
    setDragging(false);
    if (event.dataTransfer.files?.length) {
      onFiles(Array.from(event.dataTransfer.files));
    }
  }

  return (
    <div
      className={`upload-zone ${dragging ? "dragging" : ""} ${
        items.length ? "has-items" : "empty"
      }`}
      onDragOver={(event) => {
        event.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={handleDrop}
    >
      <input
        ref={inputRef}
        className="sr-only"
        type="file"
        accept="image/*"
        multiple={slot.maxFiles !== 1}
        onChange={(event) => {
          onFiles(Array.from(event.target.files ?? []));
          event.target.value = "";
        }}
      />
      <div className="upload-thumbs">
        {items.slice(0, slot.maxFiles ?? 6).map((item) => (
          <div className="upload-thumb" key={item.id}>
            <img src={item.url} alt={item.name} />
            <button
              type="button"
              aria-label={`移除${item.name}`}
              onClick={() => onRemove(item.id)}
            >
              <X size={14} />
            </button>
          </div>
        ))}
        {(slot.maxFiles ?? 6) > items.length ? (
          <button
            type="button"
            className="upload-add"
            onClick={() => inputRef.current?.click()}
            aria-label={`上传${slot.label}`}
          >
            <Plus size={24} />
            <span>{items.length ? "继续上传" : "点击上传"}</span>
            <small>支持多图上传</small>
          </button>
        ) : null}
      </div>
      {slot.hint ? <p>{slot.hint}</p> : null}
    </div>
  );
}

function TextAreaSection({ section, value, onChange, onAssist, loading }) {
  return (
    <div className="form-section textarea-section">
      <FieldNumber
        index={section.index}
        title={section.label}
        required={section.required}
        inlineAction={
          section.assist || section.actionLabel === "AI帮写" ? (
            <button
              type="button"
              className="outline-red"
              onClick={onAssist}
              disabled={loading}
            >
              {loading ? <Loader2 className="spin" size={14} /> : null}
              AI帮写
            </button>
          ) : null
        }
      />
      <label>
        <textarea
          value={value ?? ""}
          onChange={(event) => onChange(event.target.value)}
          maxLength={section.maxLength ?? 220}
          rows={section.rows ?? 3}
        />
        <span>
          {(value ?? "").length}/{section.maxLength ?? 220}
        </span>
      </label>
    </div>
  );
}

function ratioGroupLabel(groupName, options) {
  const firstOption = options?.[0];
  if (firstOption && typeof firstOption === "object" && firstOption.label) {
    return firstOption.label;
  }
  if (groupName === "common") return "常见比例";
  if (groupName === "tall") return "细长比例";
  return "细宽比例";
}

function ratioOptionValues(options = []) {
  return options.map((option) => optionValue(option));
}

function RatioGrid({ config, section, value, onChange, index }) {
  const groups = config.ratios ?? {};
  const groupedEntries = Object.entries(groups);
  const usesObjectOptions = Object.values(groups).every((options) =>
    options.every(
      (option) =>
        option && typeof option === "object" && option.label && option.value,
    ),
  );
  const hasSummaryLabels =
    usesObjectOptions &&
    Object.values(groups).some((options) =>
      options.some((option) => option.label !== option.value),
    );
  const compactGroups =
    Array.isArray(section?.groups) &&
    section.groups.length > 0 &&
    usesObjectOptions &&
    hasSummaryLabels;

  if (
    Array.isArray(section?.groups) &&
    section.groups.length > 0 &&
    usesObjectOptions &&
    !hasSummaryLabels
  ) {
    const flatOptions = groupedEntries.flatMap(([, options]) => options);
    return (
      <div className="form-section ratio-section flat-ratio-section">
        <FieldNumber index={index} title="生成比例" required />
        <div className="flat-ratio-row">
          {flatOptions.map((option) => (
            <button
              type="button"
              key={optionKey(option)}
              className={pillClass(value === optionValue(option))}
              onClick={() => onChange(optionValue(option))}
            >
              {optionLabel(option)}
            </button>
          ))}
        </div>
      </div>
    );
  }

  if (compactGroups) {
    return (
      <div className="form-section ratio-section compact-ratio-section">
        <FieldNumber index={index} title="生成比例" required />
        <div className="ratio-summary-groups">
          {groupedEntries.map(([groupName, options]) => {
            const values = ratioOptionValues(options);
            const active = values.includes(value);
            return (
              <button
                type="button"
                key={groupName}
                className={
                  active
                    ? "ratio-summary-button active"
                    : "ratio-summary-button"
                }
                onClick={() => onChange(values[0])}
              >
                <span>{ratioGroupLabel(groupName, options)}</span>
                <small>{values.join("/")}</small>
              </button>
            );
          })}
        </div>
      </div>
    );
  }

  return (
    <div className="form-section ratio-section">
      <FieldNumber index={index} title="生成比例" required />
      <div className="ratio-groups">
        {groupedEntries.map(([groupName, options]) => (
          <div className="ratio-group" key={groupName}>
            <b>{ratioGroupLabel(groupName, options)}</b>
            <div>
              {options.map((option) => (
                <button
                  type="button"
                  key={optionKey(option)}
                  className={`${pillClass(value === optionValue(option))} ${
                    option &&
                    typeof option === "object" &&
                    option.label &&
                    option.value &&
                    option.label !== option.value
                      ? "has-sub"
                      : ""
                  }`}
                  onClick={() => onChange(optionValue(option))}
                >
                  <span>{optionLabel(option)}</span>
                  {option &&
                  typeof option === "object" &&
                  option.value &&
                  option.label !== option.value ? (
                    <small>{option.value}</small>
                  ) : null}
                </button>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function Stepper({ label, value, min = 1, max = 8, onChange, index, hint }) {
  return (
    <div className="compact-control">
      <FieldNumber index={index} title={label} />
      <div className="stepper-line">
        <div className="stepper">
          <button
            type="button"
            onClick={() => onChange(Math.max(min, value - 1))}
            aria-label="减少"
          >
            <Minus size={16} />
          </button>
          <strong>{value}</strong>
          <button
            type="button"
            onClick={() => onChange(Math.min(max, value + 1))}
            aria-label="增加"
          >
            <Plus size={16} />
          </button>
        </div>
        {hint ? <span className="control-hint">{hint}</span> : null}
      </div>
    </div>
  );
}

function SelectControl({ label, value, options, onChange, index }) {
  return (
    <div className="compact-control">
      <FieldNumber index={index} title={label} />
      <label className="select-shell">
        <select
          value={value}
          onChange={(event) => onChange(event.target.value)}
        >
          {options.map((option) => (
            <option key={optionKey(option)} value={optionValue(option)}>
              {optionLabel(option)}
            </option>
          ))}
        </select>
        <ChevronDown size={16} />
      </label>
    </div>
  );
}

function CompactChoiceControl({ label, value, options, onChange, index }) {
  return (
    <div className="compact-control">
      <FieldNumber index={index} title={label} />
      <div className="compact-choice-row">
        {options.map((option) => (
          <button
            type="button"
            key={optionKey(option)}
            className={pillClass(value === optionValue(option))}
            onClick={() => onChange(optionValue(option))}
          >
            {optionLabel(option)}
          </button>
        ))}
      </div>
    </div>
  );
}

function ParamsTable({ value = [], onChange }) {
  function updateRow(rowId, key, nextValue) {
    onChange(
      value.map((row) =>
        row.id === rowId ? { ...row, [key]: nextValue } : row,
      ),
    );
  }

  function addRow() {
    if (value.length >= 9) return;
    onChange([
      ...value,
      {
        id: `param-${Date.now()}`,
        icon: "◎",
        name: "参数名称",
        value: "参数值",
      },
    ]);
  }

  return (
    <div className="form-section params-section">
      <div className="section-title-row">
        <h3>参数项</h3>
        <button type="button" onClick={addRow}>
          <Plus size={15} />
          添加参数项
        </button>
      </div>
      <div className="params-table">
        <div className="params-head">
          <span>图标</span>
          <span>名称</span>
          <span>值</span>
        </div>
        {value.map((row) => (
          <div className="params-row" key={row.id}>
            <input
              value={row.icon}
              onChange={(event) =>
                updateRow(row.id, "icon", event.target.value)
              }
            />
            <input
              value={row.name}
              onChange={(event) =>
                updateRow(row.id, "name", event.target.value)
              }
            />
            <input
              value={row.value}
              onChange={(event) =>
                updateRow(row.id, "value", event.target.value)
              }
            />
            <button
              type="button"
              aria-label="删除参数"
              onClick={() =>
                onChange(value.filter((item) => item.id !== row.id))
              }
            >
              <X size={14} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

function EditableChips({ section, value = [], onChange }) {
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState(false);
  const inputRef = useRef(null);

  function addChip() {
    const next = draft.trim();
    if (!next) return;
    onChange([...value, next]);
    setDraft("");
  }

  function focusEditor() {
    setEditing(true);
    inputRef.current?.focus();
  }

  return (
    <div className="form-section chips-edit-section">
      <div className="section-title-row">
        <h3>
          {section.index ? `${section.index}. ` : ""}
          {section.label}
        </h3>
        {section.editable || section.actionLabel ? (
          <button type="button" aria-pressed={editing} onClick={focusEditor}>
            {section.actionLabel ?? "编辑"}
          </button>
        ) : null}
      </div>
      <div className={editing ? "editable-chips editing" : "editable-chips"}>
        {value.map((chip) => (
          <button
            type="button"
            key={chip}
            className="editable-chip"
            onClick={() => onChange(value.filter((item) => item !== chip))}
            title="点击移除"
          >
            {chip}
            <X size={13} />
          </button>
        ))}
        <form
          onSubmit={(event) => {
            event.preventDefault();
            addChip();
          }}
        >
          <input
            ref={inputRef}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder={section.placeholder ?? "添加卖点"}
          />
          <button type="submit">
            <Plus size={14} />
            添加卖点
          </button>
        </form>
      </div>
    </div>
  );
}

function ColorTheme({ section, value, onChange }) {
  return (
    <div className="form-section color-section">
      <FieldNumber index={section.index} title={section.label} />
      <div className="color-themes">
        {(section.options ?? []).map((theme) => (
          <button
            key={theme.id}
            type="button"
            className={
              value === theme.id ? "color-theme active" : "color-theme"
            }
            onClick={() => onChange(theme.id)}
          >
            <span>
              {theme.colors.map((color) => (
                <i key={color} style={{ background: color }} />
              ))}
            </span>
            <b>{theme.label}</b>
          </button>
        ))}
      </div>
    </div>
  );
}

export default function GeneratorPage({ config, historyRequest }) {
  const [status, setStatus] = useState("loading");
  const [error, setError] = useState("");
  const [values, setValues] = useState(() =>
    config ? createInitialValues(config) : {},
  );
  const [uploads, setUploads] = useState(() =>
    config ? createSeedUploads(config) : {},
  );
  const [gallery, setGallery] = useState([]);
  const [selectedId, setSelectedId] = useState("");
  const [zoom, setZoom] = useState(1);
  const [activeMenu, setActiveMenu] = useState(config?.activeTool ?? "");
  const [assistLoading, setAssistLoading] = useState("");
  const [generating, setGenerating] = useState(false);
  const [historyState, setHistoryState] = useState({
    open: false,
    loading: false,
    items: [],
  });
  const fileInputs = useRef({});
  const thumbsRef = useRef(null);
  const sections = useMemo(() => numberedSections(config?.sections), [config]);
  const activeMenuItem = useMemo(() => {
    const menuItems = config?.menuItems ?? [];
    return (
      menuItems.find((item) => item.label === activeMenu) ??
      menuItems.find((item) => item.label === config?.activeTool) ??
      menuItems[0]
    );
  }, [activeMenu, config]);
  const activeModuleLabel = activeMenuItem?.label ?? config?.activeTool ?? "";
  const activeModuleId = activeMenuItem?.id ?? "";
  const panelTitle =
    activeModuleLabel && activeModuleLabel !== config?.activeTool
      ? activeModuleLabel
      : config?.title;

  useEffect(() => {
    if (!config) return;
    setValues(createInitialValues(config));
    setUploads(createSeedUploads(config));
    setActiveMenu(config.activeTool);
    setStatus("loading");
    loadPage(config.pageId).then((response) => {
      if (response.ok) {
        const nextGallery = response.data?.gallery ?? [];
        setGallery(nextGallery);
        setSelectedId(nextGallery[1]?.id ?? nextGallery[0]?.id ?? "");
        setStatus("ready");
      } else {
        setError(response.error);
        setStatus("error");
      }
    });
  }, [config]);

  useEffect(() => {
    if (!config || !historyRequest || historyRequest.pageId !== config.pageId)
      return;
    openHistory(activeModuleLabel);
  }, [config, historyRequest]);

  const selected = useMemo(
    () => gallery.find((item) => item.id === selectedId) ?? gallery[0],
    [gallery, selectedId],
  );

  if (!config) {
    return (
      <section className="generator-page load-state">页面配置加载失败</section>
    );
  }

  function updateValue(key, value) {
    setValues((current) => ({ ...current, [key]: value }));
  }

  function addFiles(slotId, files) {
    const slot = config.uploadSlots.find((item) => item.id === slotId);
    const previews = files.map(fileToPreview);
    setUploads((current) => {
      const existing = current[slotId] ?? [];
      return {
        ...current,
        [slotId]: [...existing, ...previews].slice(0, slot?.maxFiles ?? 6),
      };
    });
  }

  function removeFile(slotId, id) {
    setUploads((current) => ({
      ...current,
      [slotId]: (current[slotId] ?? []).filter((item) => item.id !== id),
    }));
  }

  function resetTask() {
    setValues(createInitialValues(config));
    setUploads(
      Object.fromEntries(
        (config.uploadSlots ?? []).map((slot) => [slot.id, []]),
      ),
    );
    setGallery([]);
    setSelectedId("");
    setZoom(1);
    setError("");
  }

  async function runAssist(section) {
    setAssistLoading(section.field);
    const response = await aiAssistCopy({
      pageId: config.pageId,
      field: section.field,
      prompt: values[section.field] ?? "",
      files: getAllUploadFiles(uploads),
    });
    setAssistLoading("");
    if (response.ok) {
      if (section.type === "chipsEditable") {
        updateValue(
          section.field,
          response.data.text
            .split(/[、，,]/)
            .map((item) => item.trim())
            .filter(Boolean),
        );
      } else {
        updateValue(section.field, response.data.text);
      }
    } else {
      setError(response.error);
    }
  }

  async function runMatchedModel(section) {
    setAssistLoading(section.field);
    const response = await generateMatchedModel({
      pageId: config.pageId,
      files: getAllUploadFiles(uploads),
    });
    setAssistLoading("");
    if (response.ok) {
      updateValue(section.field, response.data.modelImage);
    } else {
      setError(response.error);
    }
  }

  function validate() {
    const missing = (config.uploadSlots ?? []).find(
      (slot) => slot.required && !(uploads[slot.id] ?? []).length,
    );
    if (missing) {
      setError(`请先上传${missing.label}`);
      return false;
    }
    const requiredTextarea = sections.find(
      (section) =>
        section.required &&
        section.type === "textarea" &&
        !String(values[section.field] ?? "").trim(),
    );
    if (requiredTextarea) {
      setError(`请填写${requiredTextarea.label}`);
      return false;
    }
    return true;
  }

  async function runGenerate(regenerate = false) {
    if (!validate()) return;
    setGenerating(true);
    setError("");
    const requestValues = serializeGenerationValues(values);
    const response = await generateImages(config, {
      ...requestValues,
      module: activeModuleLabel,
      moduleId: activeModuleId,
      uploads: Object.values(uploads).flat(),
      files: getGenerationFiles(uploads, values, sections),
      regenerateOf: regenerate ? selected?.id : undefined,
    });
    setGenerating(false);
    if (response.ok) {
      setGallery(response.data.gallery);
      setSelectedId(
        response.data.gallery[1]?.id ?? response.data.gallery[0]?.id ?? "",
      );
      setZoom(1);
    } else {
      setError(response.error);
    }
  }

  async function openHistory(moduleLabel = activeModuleLabel) {
    setHistoryState({ open: true, loading: true, items: [], error: "" });
    const response = await loadHistory({
      pageId: config.pageId,
      module: moduleLabel,
    });
    if (response.ok) {
      setHistoryState({
        open: true,
        loading: false,
        items: response.data.items,
      });
    } else {
      setHistoryState({
        open: true,
        loading: false,
        items: [],
        error: response.error,
      });
    }
  }

  function handleMenuClick(menuItem) {
    if (isHistoryMenuItem(menuItem)) {
      openHistory(activeModuleLabel);
      return;
    }
    setActiveMenu(menuItem.label);
    setError("");
  }

  function downloadSelected() {
    if (!selected) return;
    const link = document.createElement("a");
    link.href = selected.url;
    link.download = `${config.title}-${selected.label}.svg`;
    document.body.appendChild(link);
    link.click();
    link.remove();
  }

  function renderSection(section, sectionIndex) {
    const index = section.index;
    if (section.type === "upload") {
      const slotId = section.slotId ?? section.field ?? section.id;
      const slot = config.uploadSlots.find((item) => item.id === slotId);
      if (!slot) return null;
      return (
        <div
          className="form-section upload-section"
          key={sectionKey(section, sectionIndex)}
        >
          <FieldNumber
            index={index}
            title={section.label ?? slot.label}
            required={slot.required}
          />
          <UploadStrip
            config={config}
            slot={slot}
            items={uploads[slot.id] ?? []}
            inputRef={(fileInputs.current[slot.id] ??= React.createRef())}
            onFiles={(files) => addFiles(slot.id, files)}
            onRemove={(id) => removeFile(slot.id, id)}
          />
        </div>
      );
    }
    if (section.type === "textarea") {
      return (
        <TextAreaSection
          key={sectionKey(section, sectionIndex)}
          section={section}
          value={values[section.field]}
          onChange={(value) => updateValue(section.field, value)}
          onAssist={() => runAssist(section)}
          loading={assistLoading === section.field}
        />
      );
    }
    if (section.type === "segmented") {
      return (
        <div className="form-section" key={sectionKey(section, sectionIndex)}>
          <FieldNumber index={index} title={section.label} />
          <div className="segmented-row">
            {(section.options ?? []).map((option) => (
              <button
                type="button"
                key={optionKey(option)}
                className={pillClass(
                  values[section.field] === optionValue(option),
                )}
                onClick={() => updateValue(section.field, optionValue(option))}
              >
                {optionLabel(option)}
              </button>
            ))}
          </div>
        </div>
      );
    }
    if (section.type === "chips") {
      return (
        <div className="form-section" key={sectionKey(section, sectionIndex)}>
          <FieldNumber
            index={index}
            title={section.label}
            required={section.required}
          />
          <div className="chip-row">
            {(section.options ?? []).map((option) => (
              <button
                type="button"
                key={optionKey(option)}
                className={pillClass(
                  values[section.field] === optionValue(option),
                )}
                onClick={() => updateValue(section.field, optionValue(option))}
              >
                {optionLabel(option)}
              </button>
            ))}
          </div>
        </div>
      );
    }
    if (section.type === "chipsEditable") {
      return (
        <EditableChips
          key={sectionKey(section, sectionIndex)}
          section={section}
          value={values[section.field]}
          onChange={(value) => updateValue(section.field, value)}
        />
      );
    }
    if (section.type === "ratioGrid") {
      return (
        <RatioGrid
          key={sectionKey(section, sectionIndex)}
          config={config}
          section={section}
          index={index}
          value={values.ratio}
          onChange={(value) => updateValue("ratio", value)}
        />
      );
    }
    if (section.type === "stepper") {
      if (section.options?.length) {
        return (
          <CompactChoiceControl
            key={sectionKey(section, sectionIndex)}
            index={index}
            label={section.label}
            value={values[section.field]}
            options={section.options}
            onChange={(value) => updateValue(section.field, value)}
          />
        );
      }
      return (
        <Stepper
          key={sectionKey(section, sectionIndex)}
          index={index}
          label={section.label}
          value={values[section.field] ?? config.countOptions?.min ?? 1}
          min={config.countOptions?.min ?? 1}
          max={config.countOptions?.max ?? 8}
          onChange={(value) => updateValue(section.field, value)}
          hint={section.hint}
        />
      );
    }
    if (section.type === "select") {
      if (section.variant === "buttons") {
        return (
          <CompactChoiceControl
            key={sectionKey(section, sectionIndex)}
            index={index}
            label={section.label}
            value={values[section.field]}
            options={section.options ?? config.resolutions ?? []}
            onChange={(value) => updateValue(section.field, value)}
          />
        );
      }
      return (
        <SelectControl
          key={sectionKey(section, sectionIndex)}
          index={index}
          label={section.label}
          value={values[section.field]}
          options={section.options ?? config.resolutions ?? []}
          onChange={(value) => updateValue(section.field, value)}
        />
      );
    }
    if (section.type === "modelReference") {
      const modelImage = values[section.field];
      return (
        <div
          className="form-section model-section"
          key={sectionKey(section, sectionIndex)}
        >
          <FieldNumber
            index={index}
            title={section.label}
            inlineAction={
              <button
                type="button"
                className="outline-red"
                onClick={() => runMatchedModel(section)}
                disabled={assistLoading === section.field}
              >
                {assistLoading === section.field ? (
                  <Loader2 className="spin" size={14} />
                ) : null}
                AI生成匹配模特
              </button>
            }
          />
          <button
            type="button"
            className="model-upload"
            onClick={() => fileInputs.current[section.field]?.current?.click()}
          >
            {modelImage?.url ? (
              <img src={modelImage.url} alt={modelImage.label} />
            ) : (
              <Upload size={20} />
            )}
            <span>{modelImage?.label ?? "上传/选择模特图"}</span>
          </button>
          <input
            ref={(fileInputs.current[section.field] ??= React.createRef())}
            className="sr-only"
            type="file"
            accept="image/*"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) updateValue(section.field, fileToPreview(file));
              event.target.value = "";
            }}
          />
          {section.hint ? <p className="section-hint">{section.hint}</p> : null}
        </div>
      );
    }
    if (section.type === "choiceTags" || section.type === "layoutChoices") {
      return (
        <div
          className={`form-section ${section.type === "layoutChoices" ? "layout-section" : ""}`}
          key={sectionKey(section, sectionIndex)}
        >
          <FieldNumber
            index={index}
            title={section.label}
            required={section.required}
          />
          <div
            className={
              section.type === "layoutChoices" ? "layout-choices" : "chip-row"
            }
          >
            {(section.options ?? []).map((option) => (
              <button
                type="button"
                key={option.id ?? option}
                className={pillClass(
                  values[section.field] === (option.id ?? option),
                )}
                onClick={() => updateValue(section.field, option.id ?? option)}
              >
                {option.icon ? <Icon name={option.icon} size={22} /> : null}
                <span>{option.label ?? option}</span>
              </button>
            ))}
          </div>
        </div>
      );
    }
    if (section.type === "colorTheme") {
      return (
        <ColorTheme
          key={sectionKey(section, sectionIndex)}
          section={section}
          value={values[section.field]}
          onChange={(value) => updateValue(section.field, value)}
        />
      );
    }
    if (section.type === "paramsTable") {
      return (
        <ParamsTable
          key={sectionKey(section, sectionIndex)}
          value={values[section.field]}
          onChange={(value) => updateValue(section.field, value)}
        />
      );
    }
    return null;
  }

  return (
    <section className={`generator-page ${config.pageId}`}>
      <aside className="tool-menu panel">
        <div className="menu-scroll">
          {(config.menuItems ?? []).map((item) => (
            <button
              type="button"
              key={item.id}
              className={activeMenu === item.label ? "active" : ""}
              onClick={() => handleMenuClick(item)}
            >
              <Icon name={item.icon} />
              <span>{item.label}</span>
            </button>
          ))}
        </div>
      </aside>

      <section className="config-panel panel">
        <div className="config-head">
          <h2>{panelTitle}</h2>
          <button
            type="button"
            className="outline-red new-task"
            onClick={resetTask}
          >
            新建任务
          </button>
        </div>
        <div className="config-scroll">{sections.map(renderSection)}</div>
        {config.primaryAction ? (
          <button
            type="button"
            className="red-button primary-generate"
            onClick={() => runGenerate(false)}
            disabled={generating}
          >
            {generating ? <Loader2 className="spin" size={18} /> : null}
            开始生成
          </button>
        ) : null}
      </section>

      <section className="result-panel panel">
        <div className="result-head">
          <h2>创作结果</h2>
          {config.resultToolbar === "top" ? (
            <div className="toolbar top-toolbar">
              <button
                type="button"
                className="icon-button"
                onClick={() => setZoom((value) => Math.min(1.8, value + 0.1))}
                aria-label="放大"
              >
                <ZoomIn size={23} />
              </button>
              <button
                type="button"
                className="icon-button"
                onClick={() => setZoom((value) => Math.max(0.6, value - 0.1))}
                aria-label="缩小"
              >
                <ZoomOut size={23} />
              </button>
              <button
                type="button"
                className="icon-button"
                onClick={downloadSelected}
                aria-label="下载"
              >
                <Download size={23} />
              </button>
              <button
                type="button"
                className="icon-button"
                onClick={() => runGenerate(true)}
                aria-label="重新生成"
              >
                <RefreshCw size={23} />
              </button>
            </div>
          ) : null}
        </div>

        <div className="result-main">
          {status === "loading" ? (
            <div className="state-card">加载中...</div>
          ) : null}
          {status === "error" ? (
            <div className="state-card error">加载失败：{error}</div>
          ) : null}
          {status === "ready" && !selected ? (
            <div className="state-card">暂无生成结果</div>
          ) : null}
          {selected ? (
            <img
              className="result-main-image"
              src={selected.url}
              alt={selected.label}
              style={{ transform: `scale(${zoom})` }}
            />
          ) : null}
          {generating ? (
            <div className="generating-mask">
              <Loader2 className="spin" size={28} />
              <span>生成中...</span>
            </div>
          ) : null}
          {config.resultToolbar === "side" ? (
            <div className="toolbar side-toolbar">
              <button
                type="button"
                onClick={() => setZoom((value) => Math.min(1.8, value + 0.1))}
              >
                <ZoomIn size={24} />
                <span>放大</span>
              </button>
              <button
                type="button"
                onClick={() => setZoom((value) => Math.max(0.6, value - 0.1))}
              >
                <ZoomOut size={24} />
                <span>缩小</span>
              </button>
              <button type="button" onClick={downloadSelected}>
                <Download size={24} />
                <span>下载</span>
              </button>
              <button type="button" onClick={() => runGenerate(true)}>
                <RefreshCw size={24} />
                <span>重新生成</span>
              </button>
            </div>
          ) : null}
        </div>

        <div className="thumbs-shell">
          <button
            type="button"
            className="thumb-arrow left"
            onClick={() =>
              thumbsRef.current?.scrollBy({ left: -260, behavior: "smooth" })
            }
          >
            <ChevronRight size={24} />
          </button>
          <div className="result-thumbs" ref={thumbsRef}>
            {gallery.map((item, index) => (
              <button
                type="button"
                key={item.id}
                className={
                  item.id === selectedId
                    ? "result-thumb active"
                    : "result-thumb"
                }
                onClick={() => setSelectedId(item.id)}
              >
                <img src={item.url} alt={item.label} />
                {index === 0 && item.source === "upload" ? (
                  <span className="check-dot">✓</span>
                ) : null}
                <b>{item.label}</b>
              </button>
            ))}
          </div>
          <button
            type="button"
            className="thumb-arrow right"
            onClick={() =>
              thumbsRef.current?.scrollBy({ left: 260, behavior: "smooth" })
            }
          >
            <ChevronRight size={24} />
          </button>
        </div>

        {error ? (
          <button
            type="button"
            className="error-toast"
            onClick={() => setError("")}
          >
            {error}
          </button>
        ) : null}
      </section>

      {historyState.open ? (
        <div className="history-drawer">
          <button
            type="button"
            className="history-close"
            onClick={() =>
              setHistoryState({ open: false, loading: false, items: [] })
            }
          >
            <X size={18} />
          </button>
          <h3>我的生成记录 · {activeModuleLabel}</h3>
          {historyState.loading ? <p>加载中...</p> : null}
          {historyState.error ? <p>加载失败：{historyState.error}</p> : null}
          {!historyState.loading && !historyState.items?.length ? (
            <p>暂无记录</p>
          ) : null}
          {historyState.items?.map((item) => (
            <button
              type="button"
              key={item.id}
              onClick={() => {
                setGallery([
                  { id: item.id, label: item.title, url: item.preview },
                ]);
                setSelectedId(item.id);
                setHistoryState({ open: false, loading: false, items: [] });
              }}
            >
              <img src={item.preview} alt={item.title} />
              <span>
                <b>{item.title}</b>
                <small>{item.createdAt}</small>
              </span>
            </button>
          ))}
        </div>
      ) : null}
    </section>
  );
}
