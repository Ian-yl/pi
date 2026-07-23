import { makeImage } from "./imageFactory.js";

export const mockPages = {
  "pg-1r": {
    pageId: "pg-1r",
    modules: [
      {
        id: "product",
        title: "照片级AI商品图",
        desc: "适用商品静物主图、详情图、白底图生成",
        route: "/photoreal-product",
        icon: "bag",
      },
      {
        id: "tryon",
        title: "万物穿搭上身",
        desc: "适用服饰配件上身效果生成",
        route: "/try-on",
        icon: "shirt",
      },
      {
        id: "marketing",
        title: "营销场景设计",
        desc: "适用活动海报、营销场景、节日氛围图生成",
        route: "/marketing-scene",
        icon: "megaphone",
      },
      {
        id: "assets",
        title: "电商素材生成",
        desc: "适用贴片、角标、背景素材、详情配图生成",
        route: "/commerce-assets",
        icon: "panels",
      },
    ],
  },
  "pg-1s": {
    pageId: "pg-1s",
    gallery: [
      {
        id: "origin",
        label: "原图",
        url: makeImage("product", "原图", "thumb"),
      },
      {
        id: "p-01",
        label: "01 商拍图",
        url: makeImage("product", "01 商拍图"),
      },
      {
        id: "p-02",
        label: "02 卖点海报",
        url: makeImage("product", "02 卖点海报"),
      },
      {
        id: "p-03",
        label: "03 场景海报",
        url: makeImage("product", "03 场景海报"),
      },
      {
        id: "p-04",
        label: "04 细节海报",
        url: makeImage("product", "04 细节海报"),
      },
    ],
  },
  "pg-1t": {
    pageId: "pg-1t",
    gallery: [
      { id: "origin", label: "原图", url: makeImage("tryon", "原图", "thumb") },
      { id: "t-01", label: "01 上身图", url: makeImage("tryon", "01 上身图") },
      { id: "t-02", label: "02 上身图", url: makeImage("tryon", "02 上身图") },
      { id: "t-03", label: "03 上身图", url: makeImage("tryon", "03 上身图") },
      { id: "t-04", label: "04 上身图", url: makeImage("tryon", "04 上身图") },
      { id: "t-05", label: "05 上身图", url: makeImage("tryon", "05 上身图") },
    ],
  },
  "pg-1u": {
    pageId: "pg-1u",
    gallery: [
      {
        id: "origin",
        label: "原图",
        url: makeImage("marketing", "原图", "thumb"),
      },
      {
        id: "m-01",
        label: "01 转化图",
        url: makeImage("marketing", "01 转化图"),
      },
      {
        id: "m-02",
        label: "02 转化图",
        url: makeImage("marketing", "02 转化图"),
      },
      {
        id: "m-03",
        label: "03 转化图",
        url: makeImage("marketing", "03 转化图"),
      },
    ],
  },
  "pg-1v": {
    pageId: "pg-1v",
    gallery: [
      {
        id: "origin",
        label: "原图",
        url: makeImage("assets", "原图", "thumb"),
      },
      { id: "a-01", label: "01 参数图", url: makeImage("assets", "01 参数图") },
      { id: "a-02", label: "02 参数图", url: makeImage("assets", "02 参数图") },
      { id: "a-03", label: "03 参数图", url: makeImage("assets", "03 参数图") },
    ],
  },
};

export const mockSearchItems = [
  {
    id: "s-product",
    title: "极简商品商拍",
    category: "照片级AI商品图",
    route: "/photoreal-product",
  },
  {
    id: "s-tryon",
    title: "通勤穿搭上身",
    category: "万物穿搭上身",
    route: "/try-on",
  },
  {
    id: "s-marketing",
    title: "早春换新季",
    category: "营销场景设计",
    route: "/marketing-scene",
  },
  {
    id: "s-assets",
    title: "服饰参数板块",
    category: "电商素材生成",
    route: "/commerce-assets",
  },
];
