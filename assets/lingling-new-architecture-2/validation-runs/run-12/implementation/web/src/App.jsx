import React, { useEffect, useMemo, useState } from "react";
import { ChevronDown, Search, Sparkles, UserRound, X } from "lucide-react";
import HomePage from "./pages/HomePage.jsx";
import GeneratorPage from "./pages/GeneratorPage.jsx";
import {
  productSuiteConfig,
  tryOnConfig,
} from "./pages/configs/productTryonConfigs.js";
import {
  assetsConfig,
  marketingConfig,
} from "./pages/configs/marketingAssetsConfigs.js";
import { searchTemplates } from "./data/apiClient.js";

const routes = [
  { pageId: "pg-1r", label: "首页", path: "/" },
  { pageId: "pg-1s", label: "照片级AI商品图", path: "/photoreal-product" },
  { pageId: "pg-1t", label: "万物穿搭上身", path: "/try-on" },
  { pageId: "pg-1u", label: "营销场景设计", path: "/marketing-scene" },
  { pageId: "pg-1v", label: "电商素材生成", path: "/commerce-assets" },
];

function navigate(path) {
  if (window.location.pathname !== path) {
    window.history.pushState({}, "", path);
    window.dispatchEvent(new PopStateEvent("popstate"));
  }
}

const generatorRoutes = routes.filter((route) => route.pageId !== "pg-1r");

function Header({ activePageId, onOpenHistory, onOpenAssetSpace }) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState([]);
  const [searchState, setSearchState] = useState("idle");
  const [profileOpen, setProfileOpen] = useState(false);

  async function runSearch(nextQuery = query) {
    const normalized = nextQuery.trim();
    if (!normalized) {
      setResults([]);
      setSearchState("idle");
      return;
    }
    setSearchState("loading");
    const response = await searchTemplates(normalized);
    if (response.ok) {
      setResults(response.data.items);
      setSearchState("ready");
    } else {
      setResults([]);
      setSearchState("error");
    }
  }

  return (
    <header className="topbar">
      <button
        className="brand"
        onClick={() => navigate("/")}
        aria-label="返回首页"
      >
        <span className="brand-mark">
          <Sparkles size={25} strokeWidth={2.8} />
        </span>
        <span>灵灵生图站</span>
      </button>

      <nav className="nav-tabs" aria-label="主导航">
        {routes.map((route) => (
          <button
            key={route.pageId}
            className={route.pageId === activePageId ? "active" : ""}
            onClick={() => navigate(route.path)}
          >
            {route.label}
          </button>
        ))}
      </nav>

      <div className="header-actions">
        <form
          className="search-box"
          onSubmit={(event) => {
            event.preventDefault();
            runSearch();
          }}
        >
          <Search size={22} strokeWidth={2} />
          <input
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              if (!event.target.value.trim()) {
                setResults([]);
                setSearchState("idle");
              }
            }}
            onKeyUp={(event) => {
              if (event.key !== "Enter" && query.trim().length >= 2) {
                runSearch(event.currentTarget.value);
              }
            }}
            placeholder="搜索模板、场景、素材等"
          />
          {query ? (
            <button
              className="search-clear"
              type="button"
              onClick={() => {
                setQuery("");
                setResults([]);
                setSearchState("idle");
              }}
              aria-label="清空搜索"
            >
              <X size={16} />
            </button>
          ) : null}
          {query ? (
            <div className="search-popover">
              {searchState === "loading" ? <p>搜索中...</p> : null}
              {searchState === "error" ? <p>搜索失败，请稍后重试</p> : null}
              {searchState === "ready" && results.length === 0 ? (
                <p>没有匹配的模板</p>
              ) : null}
              {results.map((item) => (
                <button
                  type="button"
                  key={item.id}
                  onClick={() => {
                    setQuery(item.title);
                    navigate(item.route);
                    setResults([]);
                  }}
                >
                  <span>{item.title}</span>
                  <small>{item.category}</small>
                </button>
              ))}
            </div>
          ) : null}
        </form>

        <button
          className="profile-button"
          onClick={() => setProfileOpen((open) => !open)}
          aria-expanded={profileOpen}
        >
          <span className="avatar">
            <UserRound size={23} strokeWidth={1.8} />
          </span>
          <ChevronDown size={20} />
        </button>
        {profileOpen ? (
          <div className="profile-menu">
            <b>视觉运营</b>
            <button
              type="button"
              onClick={() => {
                setProfileOpen(false);
                onOpenHistory();
              }}
            >
              我的生成记录
            </button>
            <button
              type="button"
              onClick={() => {
                setProfileOpen(false);
                onOpenAssetSpace();
              }}
            >
              素材空间
            </button>
          </div>
        ) : null}
      </div>
    </header>
  );
}

function routeToPage(pathname) {
  const route = routes.find((item) => item.path === pathname);
  return route ?? routes[0];
}

export default function App() {
  const [route, setRoute] = useState(() =>
    routeToPage(window.location.pathname),
  );
  const [historyRequest, setHistoryRequest] = useState(null);

  useEffect(() => {
    const handler = () => setRoute(routeToPage(window.location.pathname));
    window.addEventListener("popstate", handler);
    return () => window.removeEventListener("popstate", handler);
  }, []);

  const page = useMemo(() => {
    switch (route.pageId) {
      case "pg-1s":
        return (
          <GeneratorPage
            config={productSuiteConfig}
            navigate={navigate}
            historyRequest={historyRequest}
          />
        );
      case "pg-1t":
        return (
          <GeneratorPage
            config={tryOnConfig}
            navigate={navigate}
            historyRequest={historyRequest}
          />
        );
      case "pg-1u":
        return (
          <GeneratorPage
            config={marketingConfig}
            navigate={navigate}
            historyRequest={historyRequest}
          />
        );
      case "pg-1v":
        return (
          <GeneratorPage
            config={assetsConfig}
            navigate={navigate}
            historyRequest={historyRequest}
          />
        );
      default:
        return <HomePage navigate={navigate} />;
    }
  }, [historyRequest, route.pageId]);

  function openProfileHistory() {
    const currentGeneratorRoute =
      generatorRoutes.find((item) => item.pageId === route.pageId) ??
      generatorRoutes[0];
    setHistoryRequest({
      id: Date.now(),
      pageId: currentGeneratorRoute.pageId,
    });
    navigate(currentGeneratorRoute.path);
  }

  return (
    <main className={`app page-${route.pageId}`}>
      <Header
        activePageId={route.pageId}
        onOpenHistory={openProfileHistory}
        onOpenAssetSpace={() => navigate("/commerce-assets")}
      />
      {page}
    </main>
  );
}
