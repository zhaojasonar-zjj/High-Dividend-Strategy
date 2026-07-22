# 量化投资工具箱

> 高股息 · 贝叶斯 · 凯利公式 · DDM · 蒙特卡洛

证券投资量化分析工具集。以高股息策略选股为基础，结合贝叶斯定理动态更新概率、凯利公式分配仓位，覆盖定价分析、组合仿真与周期定位。

## 作者

**赵建军** — 独立设计与开发

- GitHub: [@zhaojasonar-zjj](https://github.com/zhaojasonar-zjj)

## 应用列表

| 应用 | 路径 | 说明 |
|------|------|------|
| 高股息贝叶斯凯利公式 | `/portfolio/` | 高股息选股 + 贝叶斯概率更新 + 凯利公式仓位分配 |
| DDM 概率定价分析 | `/ddm/` | 基于股利贴现模型的多场景概率定价 |
| 多资产组合蒙特卡洛仿真 | `/monte-carlo/` | 多资产股票组合随机模拟，收益分布与风险指标 |
| 白酒周期定位进程 | `/baijiu/` | 白酒行业周期四层传导模型，量化评估周期阶段 |
| P/E 估值压力测试器 | `/tools/pe_stress_test.html` | 市盈率敏感性分析与安全边际测试 |

## 技术栈

- 纯原生 HTML / CSS / JavaScript（无框架依赖）
- Chart.js（蒙特卡洛可视化）
- GitHub Contents API（云端数据同步）
- GitHub Pages 部署

## 在线访问

https://zhaojasonar-zjj.github.io/High-Dividend-Strategy/

## 版权

Copyright © 2026 赵建军。本项目采用 [MIT License](LICENSE) 开源。
