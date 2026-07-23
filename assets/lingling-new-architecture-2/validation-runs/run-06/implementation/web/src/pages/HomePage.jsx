import React, { useEffect, useMemo, useState } from "react";
import {
  ArrowRight,
  Megaphone,
  PanelsTopLeft,
  Shirt,
  ShoppingBag,
  Sparkles,
} from "lucide-react";
import { loadPage } from "../data/apiClient.js";

const PAGE_ID = "pg-1r";

const fallbackRoutes = {
  product: "/photoreal-product",
  tryon: "/try-on",
  marketing: "/marketing-scene",
  assets: "/commerce-assets",
};

const moduleIcons = {
  bag: ShoppingBag,
  shirt: Shirt,
  megaphone: Megaphone,
  panels: PanelsTopLeft,
};

function HomeAtmosphere() {
  return (
    <div className="home-atmosphere" aria-hidden="true">
      <div className="home-studio-left">
        <span className="studio-softbox" />
        <span className="studio-light-arm" />
        <span className="studio-clothes-rack">
          <i />
          <i />
          <i />
          <i />
        </span>
      </div>

      <div className="home-red-lines">
        <span />
        <span />
        <span />
        <span />
      </div>
    </div>
  );
}

function HomeVisualBoard() {
  return (
    <div className="home-visual-board" aria-hidden="true">
      <div className="visual-grid" />
      <div className="visual-canvas visual-canvas-main">
        <span className="visual-label">NEW ARRIVAL</span>
        <span className="visual-season">SPRING / SUMMER</span>
        <span className="visual-model" />
        <span className="visual-swatch visual-swatch-red" />
        <span className="visual-swatch visual-swatch-soft" />
        <span className="visual-swatch visual-swatch-deep" />
      </div>
      <div className="visual-canvas visual-canvas-scene">
        <span className="scene-panel" />
        <span className="scene-chair" />
        <span className="scene-vase" />
      </div>
      <div className="visual-canvas visual-canvas-product">
        <span className="product-bag" />
      </div>
      <div className="visual-promo">
        <b>30%</b>
        <span>OFF</span>
      </div>
    </div>
  );
}

function HomeState({ status, error }) {
  const isLoading = status === "loading";
  const title = isLoading
    ? "首页加载中"
    : status === "error"
      ? "首页加载失败"
      : "暂无可用入口";
  const message = isLoading
    ? "正在同步电商视觉模块..."
    : status === "error"
      ? error || "请稍后重试"
      : "当前没有可展示的生成模块";

  return (
    <section className={`home-page home-page-${status}`} aria-busy={isLoading}>
      <HomeAtmosphere />
      <div className="home-hero">
        <h1 className="hero-title">{title}</h1>
        <p className="hero-subtitle">{message}</p>
      </div>
    </section>
  );
}

export default function HomePage({ navigate }) {
  const [pageState, setPageState] = useState({
    status: "loading",
    data: null,
    error: "",
  });

  useEffect(() => {
    let isCurrent = true;

    async function loadHomePage() {
      setPageState({ status: "loading", data: null, error: "" });

      try {
        const response = await loadPage(PAGE_ID);
        if (!isCurrent) return;

        if (!response.ok) {
          setPageState({
            status: "error",
            data: null,
            error: response.error || "首页数据请求失败",
          });
          return;
        }

        setPageState({ status: "ready", data: response.data, error: "" });
      } catch (error) {
        if (!isCurrent) return;
        setPageState({
          status: "error",
          data: null,
          error: error instanceof Error ? error.message : "首页数据请求失败",
        });
      }
    }

    loadHomePage();

    return () => {
      isCurrent = false;
    };
  }, []);

  const modules = useMemo(() => {
    if (!Array.isArray(pageState.data?.modules)) return [];
    return pageState.data.modules.map((module) => ({
      ...module,
      route: fallbackRoutes[module.id] || module.route,
    }));
  }, [pageState.data]);

  if (pageState.status === "loading" || pageState.status === "error") {
    return <HomeState status={pageState.status} error={pageState.error} />;
  }

  if (modules.length === 0) {
    return <HomeState status="empty" />;
  }

  return (
    <section className="home-page">
      <HomeAtmosphere />

      <div className="home-hero">
        <h1 className="hero-title">
          <span>让商品视觉，</span>
          <span className="hero-kicker" aria-hidden="true">
            <Sparkles size={38} strokeWidth={2.4} />
          </span>
          <br />
          <span>随场景一键生长</span>
        </h1>
        <p className="hero-subtitle">
          从商品主图到穿搭、场景与素材，统一生成可上架电商视觉。
        </p>
      </div>

      <HomeVisualBoard />

      <div className="module-cards">
        {modules.map((module) => {
          const Icon = moduleIcons[module.icon] || ShoppingBag;

          return (
            <button
              className="module-card"
              type="button"
              key={module.id}
              onClick={() => navigate(module.route)}
            >
              <span className="module-icon" aria-hidden="true">
                <Icon size={56} strokeWidth={1.8} />
              </span>
              <span className="module-copy">
                <strong>{module.title}</strong>
                <span>{module.desc}</span>
              </span>
              <span className="module-arrow" aria-hidden="true">
                <ArrowRight size={30} strokeWidth={2.2} />
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
