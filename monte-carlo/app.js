/* global MCSimCore, Chart */
(function initializeApplication() {
    "use strict";

    const MAX_ASSETS = 12;
    const MAX_WORK_UNITS = 120000000; // days × paths × assets²，防止极端组合长时间占用 Worker
    const INITIAL_VALUE = 100;

    const defaultAssets = [
        { name: "核心科技股A", price: 100, weight: 40, mu: 12, sigma: 25 },
        { name: "消费蓝筹股B", price: 50, weight: 40, mu: 8, sigma: 18 },
        { name: "黄金避险资产C", price: 200, weight: 20, mu: 4, sigma: 12 }
    ];

    const defaultCorrelation = [
        [1, 0.4, -0.1],
        [0.4, 1, 0],
        [-0.1, 0, 1]
    ];

    let assets = structuredClone(defaultAssets);
    let correlationMatrix = structuredClone(defaultCorrelation);
    let pathsChartInstance = null;
    let distChartInstance = null;
    let simulationWorker = null;
    let lastResult = null;
    let lastRunConfig = null;
    let lastRunStartedAt = 0;

    const els = {};

    document.addEventListener("DOMContentLoaded", () => {
        cacheElements();
        attachEvents();
        renderAssetsTable();
        renderCorrelationMatrix();
        toggleModelParams();
        updateWeightStatus();
        setStatus(els.runStatus, "系统已就绪，正在运行默认示例……", "");
        window.setTimeout(runSimulation, 80);
    });

    function cacheElements() {
        [
            "modelChoice", "holdingMode", "simDays", "simPaths", "randomSeed", "randomSeedBtn",
            "jumpParamsGroup", "jumpLambda", "jumpMu", "jumpSigma", "jumpCorrelation",
            "studentParamsGroup", "studentDf",
            "addAssetBtn", "normalizeWeightsBtn", "assetsTable", "weightStatus",
            "resetMatrixBtn", "matrixContainer", "matrixStatus", "runBtn", "cancelBtn",
            "progressBar", "runStatus", "exportCsvBtn", "resultSummary", "pathsChart",
            "distChart", "chartStatus", "mExpectedNav", "mExpectedReturn", "mMedianNav",
            "mNavStd", "mProbLoss", "mMeanMaxDD", "mRisk95", "mRisk99",
            "calibrationPanel", "calibrationContent"
        ].forEach((id) => {
            els[id] = document.getElementById(id);
        });
    }

    function attachEvents() {
        els.modelChoice.addEventListener("change", toggleModelParams);
        els.randomSeedBtn.addEventListener("click", () => {
            els.randomSeed.value = String(generateRandomSeed());
        });
        els.addAssetBtn.addEventListener("click", addAsset);
        els.normalizeWeightsBtn.addEventListener("click", normalizeWeights);
        els.resetMatrixBtn.addEventListener("click", resetCorrelationMatrix);
        els.runBtn.addEventListener("click", runSimulation);
        els.cancelBtn.addEventListener("click", cancelSimulation);
        els.exportCsvBtn.addEventListener("click", exportCsv);
    }

    function toggleModelParams() {
        const model = els.modelChoice.value;
        els.jumpParamsGroup.hidden = (model !== "JUMP" && model !== "STUDENT_T_JUMP");
        els.studentParamsGroup.hidden = (model !== "STUDENT_T" && model !== "STUDENT_T_JUMP");
    }

    function generateRandomSeed() {
        if (window.crypto && window.crypto.getRandomValues) {
            return window.crypto.getRandomValues(new Uint32Array(1))[0];
        }
        return Math.floor(Math.random() * 4294967295);
    }

    function renderAssetsTable() {
        const tbody = els.assetsTable.querySelector("tbody");
        tbody.textContent = "";

        assets.forEach((asset, index) => {
            const row = document.createElement("tr");

            row.appendChild(createTableInput("text", asset.name, (value) => {
                asset.name = value.trim() || `资产 ${index + 1}`;
                renderCorrelationMatrix();
            }, { ariaLabel: `资产 ${index + 1} 名称`, note: "仅用于展示和矩阵标识，不参与定价。" }));

            row.appendChild(createTableInput("number", asset.price, (value) => {
                asset.price = Number(value);
            }, {
                min: 0.0001,
                step: 0.01,
                ariaLabel: `${asset.name} 初始价格`,
                note: "正数；决定初始份额，净值归一化后价格比例尺不影响结果。"
            }));

            row.appendChild(createTableInput("number", asset.weight, (value) => {
                asset.weight = Number(value);
                updateWeightStatus();
            }, {
                min: 0,
                max: 100,
                step: 0.01,
                ariaLabel: `${asset.name} 权重`,
                note: "目标市值占比；各资产合计必须为 100%。"
            }));

            row.appendChild(createTableInput("number", asset.mu, (value) => {
                asset.mu = Number(value);
            }, {
                step: 0.01,
                ariaLabel: `${asset.name} 预期年收益率`,
                note: "年化漂移 μ；Student-t 下为近似目标，肥尾会扩大均值抽样误差。"
            }));

            row.appendChild(createTableInput("number", asset.sigma, (value) => {
                asset.sigma = Number(value);
            }, {
                min: 0,
                step: 0.01,
                ariaLabel: `${asset.name} 年化波动率`,
                note: "年化扩散波动 σ；越大价格路径和期末净值越分散。"
            }));

            const actionCell = document.createElement("td");
            const deleteButton = document.createElement("button");
            deleteButton.type = "button";
            deleteButton.className = "btn btn-danger";
            deleteButton.textContent = "删除";
            deleteButton.disabled = assets.length <= 1;
            deleteButton.addEventListener("click", () => removeAsset(index));
            actionCell.appendChild(deleteButton);
            row.appendChild(actionCell);

            tbody.appendChild(row);
        });
    }

    function createTableInput(type, value, onChange, options) {
        const cell = document.createElement("td");
        const input = document.createElement("input");
        input.type = type;
        input.className = "form-control";
        input.value = value;
        input.setAttribute("aria-label", options.ariaLabel || "资产参数");

        ["min", "max", "step"].forEach((attribute) => {
            if (options[attribute] !== undefined) input.setAttribute(attribute, options[attribute]);
        });

        input.addEventListener("input", () => onChange(input.value));
        cell.appendChild(input);
        if (options.note) {
            const note = document.createElement("small");
            note.className = "field-note";
            note.textContent = options.note;
            cell.appendChild(note);
        }
        return cell;
    }

    function addAsset() {
        if (assets.length >= MAX_ASSETS) {
            setStatus(els.weightStatus, `为保证矩阵可读性与计算稳定性，最多支持 ${MAX_ASSETS} 个资产。`, "warn");
            return;
        }

        const index = assets.length;
        assets.push({
            name: `新资产 ${index + 1}`,
            price: 100,
            weight: 0,
            mu: 8,
            sigma: 20
        });

        correlationMatrix.forEach((row) => row.push(0));
        const newRow = Array(index + 1).fill(0);
        newRow[index] = 1;
        correlationMatrix.push(newRow);

        renderAssetsTable();
        renderCorrelationMatrix();
        updateWeightStatus();
    }

    function removeAsset(index) {
        if (assets.length <= 1) return;
        assets.splice(index, 1);
        correlationMatrix.splice(index, 1);
        correlationMatrix.forEach((row) => row.splice(index, 1));
        renderAssetsTable();
        renderCorrelationMatrix();
        updateWeightStatus();
    }

    function normalizeWeights() {
        const total = assets.reduce((sum, asset) => sum + (Number(asset.weight) || 0), 0);
        if (!(total > 0)) {
            setStatus(els.weightStatus, "总权重必须大于 0，无法归一化。", "error");
            return;
        }
        assets.forEach((asset) => {
            asset.weight = roundTo((Number(asset.weight) || 0) * 100 / total, 6);
        });
        renderAssetsTable();
        updateWeightStatus();
    }

    function updateWeightStatus() {
        const total = assets.reduce((sum, asset) => sum + (Number(asset.weight) || 0), 0);
        if (Math.abs(total - 100) <= 0.01) {
            setStatus(els.weightStatus, `当前总权重 ${formatNumber(total)}%，校验通过。`, "ok");
        } else {
            setStatus(els.weightStatus, `当前总权重 ${formatNumber(total)}%，运行前必须等于 100%。`, "warn");
        }
    }

    function renderCorrelationMatrix() {
        els.matrixContainer.textContent = "";
        const table = document.createElement("table");
        table.className = "matrix-table";
        const thead = document.createElement("thead");
        const headerRow = document.createElement("tr");
        headerRow.appendChild(document.createElement("th"));

        assets.forEach((asset) => {
            const th = document.createElement("th");
            th.textContent = asset.name;
            th.title = asset.name;
            headerRow.appendChild(th);
        });
        thead.appendChild(headerRow);
        table.appendChild(thead);

        const tbody = document.createElement("tbody");
        assets.forEach((rowAsset, rowIndex) => {
            const row = document.createElement("tr");
            const rowHeader = document.createElement("th");
            rowHeader.scope = "row";
            rowHeader.textContent = rowAsset.name;
            rowHeader.title = rowAsset.name;
            row.appendChild(rowHeader);

            assets.forEach((columnAsset, columnIndex) => {
                const cell = document.createElement("td");
                const input = document.createElement("input");
                input.type = "number";
                input.className = "form-control matrix-input";
                input.min = "-1";
                input.max = "1";
                input.step = "0.01";
                input.value = correlationMatrix[rowIndex][columnIndex];
                input.dataset.row = String(rowIndex);
                input.dataset.column = String(columnIndex);
                input.setAttribute("aria-label", `${rowAsset.name} 与 ${columnAsset.name} 的相关系数`);

                if (rowIndex === columnIndex) {
                    input.disabled = true;
                } else {
                    input.addEventListener("change", handleCorrelationChange);
                }
                cell.appendChild(input);
                row.appendChild(cell);
            });
            tbody.appendChild(row);
        });
        table.appendChild(tbody);
        els.matrixContainer.appendChild(table);
        setStatus(els.matrixStatus, "修改后将在下一次运行时进行半正定校验。", "");
    }

    function handleCorrelationChange(event) {
        const input = event.currentTarget;
        const row = Number(input.dataset.row);
        const column = Number(input.dataset.column);
        let value = Number(input.value);
        if (!Number.isFinite(value)) value = 0;
        value = MCSimCore.clamp(value, -1, 1);

        correlationMatrix[row][column] = value;
        correlationMatrix[column][row] = value;
        input.value = String(value);

        const mirrored = els.matrixContainer.querySelector(
            `input[data-row="${column}"][data-column="${row}"]`
        );
        if (mirrored) mirrored.value = String(value);
    }

    function resetCorrelationMatrix() {
        const size = assets.length;
        correlationMatrix = Array.from({ length: size }, (_, row) => (
            Array.from({ length: size }, (_, column) => (row === column ? 1 : 0))
        ));

        var message;
        if (size === defaultCorrelation.length) {
            correlationMatrix = structuredClone(defaultCorrelation);
            message = "相关系数矩阵已恢复默认设置。";
        } else {
            message = "当前资产数量与默认配置不一致，已重置为单位矩阵（资产间互不相关）。";
        }
        renderCorrelationMatrix();
        setStatus(els.matrixStatus, message, "ok");
    }

    function runSimulation() {
        if (simulationWorker) {
            simulationWorker.terminate();
            simulationWorker = null;
        }

        const validation = validateAndBuildConfig();
        if (!validation.ok) {
            setStatus(els.runStatus, validation.errors.join("；"), "error");
            els.resultSummary.textContent = "参数校验未通过，请根据左侧提示修正后重新运行。";
            return;
        }

        lastRunConfig = validation.config;
        lastResult = null;
        lastRunStartedAt = performance.now();
        els.exportCsvBtn.disabled = true;
        setRunningState(true);
        updateProgress(0);
        setStatus(els.runStatus, `仿真进行中，随机种子：${validation.config.seed}。`, "");

        try {
            simulationWorker = MCSimCore.createSimulationWorker();
        } catch (error) {
            simulationWorker = null;
        }
        if (!simulationWorker) {
            setStatus(els.runStatus, "当前浏览器无法创建后台 Worker，已切换为主线程兼容模式。", "warn");
            runSynchronously(validation.config);
            return;
        }

        simulationWorker.onmessage = (event) => {
            const message = event.data;
            if (message.type === "progress") {
                updateProgress(message.progress);
            } else if (message.type === "result") {
                finishSimulation(message.result);
            } else {
                failSimulation(message.message || "仿真 Worker 发生未知错误。");
            }
        };

        simulationWorker.onerror = (event) => {
            failSimulation(event.message || "仿真 Worker 启动失败。");
        };

        simulationWorker.postMessage(validation.config);
    }

    function runSynchronously(config) {
        window.setTimeout(() => {
            try {
                const result = MCSimCore.simulatePortfolio(config, updateProgress);
                finishSimulation(result);
            } catch (error) {
                failSimulation(error.message || String(error));
            }
        }, 0);
    }

    function cancelSimulation() {
        if (simulationWorker) {
            simulationWorker.terminate();
            simulationWorker = null;
        }
        setRunningState(false);
        updateProgress(0);
        setStatus(els.runStatus, "本次仿真已取消。", "warn");
    }

    function finishSimulation(result) {
        if (simulationWorker) {
            simulationWorker.terminate();
            simulationWorker = null;
        }

        lastResult = result;
        const elapsedSeconds = (performance.now() - lastRunStartedAt) / 1000;
        const metrics = MCSimCore.calculateMetrics(
            result.finalValues,
            result.maxDrawdowns,
            result.initialValue || INITIAL_VALUE
        );

        renderMetrics(metrics);
        renderCharts(result);
        updateProgress(1);
        setRunningState(false);
        els.exportCsvBtn.disabled = false;

        const modelNames = {
            GBM: "GBM（正态噪声）",
            STUDENT_T: `Student-t GBM（ν=${lastRunConfig.student.df}）`,
            JUMP: "Merton 跳跃扩散",
            STUDENT_T_JUMP: `Student-t + 跳跃扩散（ν=${lastRunConfig.student.df}）`
        };
        const modelName = modelNames[lastRunConfig.model] || lastRunConfig.model;
        const modeName = lastRunConfig.holdingMode === "dailyRebalance" ? "每日再平衡" : "买入并持有";
        setStatus(els.runStatus, `仿真完成，用时 ${elapsedSeconds.toFixed(2)} 秒。`, "ok");
        els.resultSummary.textContent = `${lastRunConfig.paths.toLocaleString("zh-CN")} 条路径 × ${lastRunConfig.days} 个交易日；模型：${modelName}；口径：${modeName}；随机种子：${result.seed}。`;
        renderCalibration(result.calibration);
    }

    function failSimulation(message) {
        if (simulationWorker) {
            simulationWorker.terminate();
            simulationWorker = null;
        }
        setRunningState(false);
        updateProgress(0);
        setStatus(els.runStatus, `仿真失败：${message}`, "error");
    }

    function validateAndBuildConfig() {
        const errors = [];
        clearInvalidMarks();

        const days = readIntegerInput(els.simDays, "模拟交易日", 5, 1000, errors);
        const paths = readIntegerInput(els.simPaths, "模拟路径数", 100, 10000, errors);
        const seed = readSeed(errors);
        const model = els.modelChoice.value;
        const holdingMode = els.holdingMode.value;
        if (!["GBM", "STUDENT_T", "JUMP", "STUDENT_T_JUMP"].includes(model)) {
            errors.push("资产价格模型不受支持");
        }

        if (assets.length < 1 || assets.length > MAX_ASSETS) {
            errors.push(`资产数量必须在 1 至 ${MAX_ASSETS} 之间`);
        }

        const workUnits = days * paths * assets.length * assets.length;
        if (workUnits > MAX_WORK_UNITS) {
            errors.push("当前资产数、交易日与路径数的组合计算量过大，请降低其中至少一项参数");
        }

        let totalWeight = 0;
        assets.forEach((asset, index) => {
            const label = asset.name || `第 ${index + 1} 个资产`;
            if (!Number.isFinite(asset.price) || asset.price <= 0) {
                errors.push(`${label} 的初始价格必须大于 0`);
            }
            if (!Number.isFinite(asset.weight) || asset.weight < 0 || asset.weight > 100) {
                errors.push(`${label} 的权重必须位于 0 至 100 之间`);
            }
            if (!Number.isFinite(asset.mu)) {
                errors.push(`${label} 的预期年收益率必须是有限数值`);
            }
            if (!Number.isFinite(asset.sigma) || asset.sigma < 0 || asset.sigma > 500) {
                errors.push(`${label} 的年化波动率必须位于 0 至 500 之间`);
            }
            totalWeight += Number(asset.weight) || 0;
        });

        if (Math.abs(totalWeight - 100) > 0.01) {
            errors.push(`资产总权重为 ${formatNumber(totalWeight)}%，必须等于 100%`);
        }

        const jump = {
            lambda: 0,
            mu: 0,
            sigma: 0,
            correlation: 0
        };
        if (model === "JUMP" || model === "STUDENT_T_JUMP") {
            jump.lambda = readNumberInput(els.jumpLambda, "年化跳跃频率", 0, 50, errors);
            jump.mu = readNumberInput(els.jumpMu, "平均对数跳跃", -5, 5, errors);
            jump.sigma = readNumberInput(els.jumpSigma, "跳跃波动率", 0, 2, errors);
            jump.correlation = readNumberInput(els.jumpCorrelation, "系统性跳跃占比", 0, 1, errors);
        }

        const student = { df: 5 };
        if (model === "STUDENT_T" || model === "STUDENT_T_JUMP") {
            student.df = readNumberInput(els.studentDf, "Student-t 自由度", 2.1, 100, errors);
        }

        if (errors.length > 0) {
            return { ok: false, errors };
        }

        const matrixResult = MCSimCore.nearestCorrelationMatrix(correlationMatrix);
        if (!matrixResult.ok) {
            setStatus(els.matrixStatus, matrixResult.message, "error");
            return { ok: false, errors: [matrixResult.message] };
        }

        if (matrixResult.adjusted) {
            correlationMatrix = matrixResult.matrix.map((row) => row.map((value) => roundTo(value, 6)));
            renderCorrelationMatrix();
            setStatus(els.matrixStatus, "原矩阵不是半正定矩阵，已自动修复为最近的有效相关矩阵。", "warn");
        } else {
            setStatus(els.matrixStatus, "相关矩阵通过半正定校验。", "ok");
        }

        return {
            ok: true,
            config: {
                model,
                holdingMode,
                days,
                paths,
                seed,
                initialValue: INITIAL_VALUE,
                assets: assets.map((asset) => ({
                    name: asset.name,
                    weight: asset.weight / 100,
                    mu: asset.mu / 100,
                    sigma: asset.sigma / 100,
                    initialPrice: asset.price
                })),
                jump,
                student,
                cholesky: matrixResult.cholesky
            }
        };
    }

    function clearInvalidMarks() {
        document.querySelectorAll(".form-control.invalid").forEach((input) => {
            input.classList.remove("invalid");
        });
    }

    function readIntegerInput(input, label, min, max, errors) {
        const value = Number(input.value);
        if (!Number.isInteger(value) || value < min || value > max) {
            input.classList.add("invalid");
            errors.push(`${label}必须是 ${min} 至 ${max} 的整数`);
            return min;
        }
        return value;
    }

    function readNumberInput(input, label, min, max, errors) {
        const value = Number(input.value);
        if (!Number.isFinite(value) || value < min || value > max) {
            input.classList.add("invalid");
            errors.push(`${label}必须位于 ${min} 至 ${max} 之间`);
            return min;
        }
        return value;
    }

    function readSeed(errors) {
        const raw = els.randomSeed.value.trim();
        if (raw === "") return generateRandomSeed();
        const value = Number(raw);
        if (!Number.isInteger(value) || value < 0 || value > 4294967295) {
            els.randomSeed.classList.add("invalid");
            errors.push("随机种子必须是 0 至 4294967295 的整数，或留空");
            return 0;
        }
        return value;
    }

    function renderCalibration(cal) {
        if (!cal) {
            els.calibrationPanel.hidden = true;
            return;
        }
        els.calibrationPanel.hidden = false;

        const useStudentT = cal.model === "STUDENT_T" || cal.model === "STUDENT_T_JUMP";
        const useJump = cal.model === "JUMP" || cal.model === "STUDENT_T_JUMP";

        let html = '<div class="calib-grid">';

        if (useStudentT) {
            html += [
                '<div class="calib-item">',
                '<span class="calib-label">Student-t 自由度 ν</span>',
                `<span class="calib-value">${formatNumber(cal.studentDf, 2)}</span>`,
                '</div>',
                '<div class="calib-item">',
                '<span class="calib-label">方差归一化因子 √((ν−2)/ν)</span>',
                `<span class="calib-value">${formatNumber(cal.varianceScale, 6)}</span>`,
                '</div>',
                '<div class="calib-item calib-note">',
                '<span class="calib-label">校准说明</span>',
                '<span class="calib-value">Tν 缩放至单位方差，σ 保持 GBM 金融含义</span>',
                '</div>'
            ].join('');
        }

        if (useJump) {
            html += [
                '<div class="calib-item">',
                '<span class="calib-label">跳跃频率 λ</span>',
                `<span class="calib-value">${formatNumber(cal.jumpLambda, 4)} /年</span>`,
                '</div>',
                '<div class="calib-item">',
                '<span class="calib-label">跳跃均值 μJ</span>',
                `<span class="calib-value">${formatSignedPercent(cal.jumpMu, 2)}</span>`,
                '</div>',
                '<div class="calib-item">',
                '<span class="calib-label">跳跃波动 σJ</span>',
                `<span class="calib-value">${formatPercent(cal.jumpSigma, 2)}</span>`,
                '</div>',
                '<div class="calib-item">',
                '<span class="calib-label">跳跃补偿 κ = exp(μJ + σJ²/2) − 1</span>',
                `<span class="calib-value">${formatSignedPercent(cal.kappa, 4)}</span>`,
                '</div>',
                '<div class="calib-item calib-highlight">',
                '<span class="calib-label">漂移补偿 λκ</span>',
                `<span class="calib-value">${formatSignedPercent(cal.driftCompensation, 4)} /年</span>`,
                '</div>'
            ].join('');

            if (cal.assetDrifts && cal.assetDrifts.length > 0) {
                html += '<div class="calib-item calib-drift-table"><span class="calib-label">有效年化漂移 μ_eff = μ − λκ</span><div class="calib-drift-list">';
                cal.assetDrifts.forEach(function (ad) {
                    var safeName = String(ad.name).replace(/</g, "&lt;").replace(/>/g, "&gt;");
                    html += '<div class="calib-drift-row">' +
                        '<span class="calib-drift-name">' + safeName + '</span>' +
                        '<span class="calib-drift-mu">' + formatPercent(ad.mu, 2) + '</span>' +
                        '<span class="calib-drift-arrow">→</span>' +
                        '<span class="calib-drift-eff">' + formatPercent(ad.effectiveDrift, 2) + '</span>' +
                        '</div>';
                });
                html += '</div></div>';
            }
        }

        if (!useStudentT && !useJump) {
            html += '<div class="calib-item"><span class="calib-label">模型</span><span class="calib-value">标准 GBM，无需校准</span></div>';
        }

        if (cal.antitheticVariates) {
            html += '<div class="calib-item calib-note"><span class="calib-label">方差缩减</span><span class="calib-value">对偶变差已启用（路径配对 Z 与 −Z）</span></div>';
        }

        html += '</div>';
        els.calibrationContent.innerHTML = html;
    }

    function renderMetrics(metrics) {
        els.mExpectedNav.textContent = formatNumber(metrics.mean);
        els.mExpectedReturn.textContent = formatSignedPercent(metrics.expectedReturn);
        els.mMedianNav.textContent = formatNumber(metrics.median);
        els.mNavStd.textContent = formatNumber(metrics.standardDeviation);
        els.mProbLoss.textContent = formatPercent(metrics.probabilityOfLoss);
        els.mMeanMaxDD.textContent = formatPercent(metrics.meanMaxDrawdown);
        els.mRisk95.textContent = `${formatNumber(metrics.var95)}% / ${formatNumber(metrics.cvar95)}%`;
        els.mRisk99.textContent = `${formatNumber(metrics.var99)}% / ${formatNumber(metrics.cvar99)}%`;
    }

    function renderCharts(result) {
        if (typeof Chart === "undefined") {
            setStatus(els.chartStatus, "Chart.js 未能加载，数值结果不受影响，但图表无法显示。", "warn");
            return;
        }

        renderPathsChart(result.chartPaths);
        renderDistributionChart(result.finalValues);
        setStatus(els.chartStatus, "", "");
    }

    function renderPathsChart(chartPaths) {
        const days = chartPaths[0] ? chartPaths[0].length - 1 : 0;
        const labels = Array.from({ length: days + 1 }, (_, index) => index);
        const datasets = chartPaths.map((path, index) => ({
            label: `路径 ${index + 1}`,
            data: Array.from(path),
            borderColor: index === 0 ? "rgba(37, 99, 235, 0.90)" : "rgba(100, 116, 139, 0.18)",
            borderWidth: index === 0 ? 2 : 1,
            pointRadius: 0,
            tension: 0.15
        }));

        if (pathsChartInstance) pathsChartInstance.destroy();
        pathsChartInstance = new Chart(els.pathsChart, {
            type: "line",
            data: { labels, datasets },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                animation: false,
                interaction: { mode: "nearest", intersect: false },
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        callbacks: {
                            title: (items) => `第 ${items[0].label} 个交易日`,
                            label: (item) => `净值：${formatNumber(item.parsed.y)}`
                        }
                    }
                },
                scales: {
                    x: {
                        title: { display: true, text: "交易日" },
                        ticks: { maxTicksLimit: 10 }
                    },
                    y: {
                        title: { display: true, text: "组合净值（期初 = 100）" }
                    }
                }
            }
        });
    }

    function renderDistributionChart(finalValues) {
        const histogram = MCSimCore.buildHistogram(finalValues, 32);
        if (distChartInstance) distChartInstance.destroy();
        distChartInstance = new Chart(els.distChart, {
            type: "bar",
            data: {
                labels: histogram.labels,
                datasets: [{
                    label: "路径数量",
                    data: histogram.counts,
                    backgroundColor: "rgba(5, 150, 105, 0.62)",
                    borderColor: "rgba(5, 150, 105, 1)",
                    borderWidth: 1
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                animation: false,
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        callbacks: {
                            title: (items) => `净值区间 ${histogram.labels[items[0].dataIndex]}`,
                            label: (item) => `路径数量：${item.parsed.y}`
                        }
                    }
                },
                scales: {
                    x: {
                        title: { display: true, text: "期末净值区间" },
                        ticks: { maxTicksLimit: 8, maxRotation: 45 }
                    },
                    y: {
                        beginAtZero: true,
                        title: { display: true, text: "路径数量" }
                    }
                }
            }
        });
    }

    function exportCsv() {
        if (!lastResult) return;
        const lines = ["path,terminal_nav,max_drawdown"];
        for (let i = 0; i < lastResult.finalValues.length; i += 1) {
            lines.push([
                i + 1,
                lastResult.finalValues[i].toFixed(8),
                lastResult.maxDrawdowns[i].toFixed(8)
            ].join(","));
        }

        const blob = new Blob(["\uFEFF" + lines.join("\n")], { type: "text/csv;charset=utf-8" });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = `蒙特卡洛路径结果_seed_${lastResult.seed}.csv`;
        document.body.appendChild(link);
        link.click();
        link.remove();
        URL.revokeObjectURL(url);
    }

    function setRunningState(isRunning) {
        els.runBtn.disabled = isRunning;
        els.cancelBtn.disabled = !isRunning;
        els.runBtn.textContent = isRunning ? "仿真计算中……" : "开始蒙特卡洛仿真";
    }

    function updateProgress(progress) {
        els.progressBar.style.width = `${Math.round(MCSimCore.clamp(progress, 0, 1) * 100)}%`;
    }

    function setStatus(element, message, type) {
        element.textContent = message;
        element.classList.remove("ok", "warn", "error");
        if (type) element.classList.add(type);
    }

    function formatNumber(value, digits = 2) {
        return Number(value).toLocaleString("zh-CN", {
            minimumFractionDigits: digits,
            maximumFractionDigits: digits
        });
    }

    function formatPercent(value, digits = 2) {
        return `${formatNumber(value * 100, digits)}%`;
    }

    function formatSignedPercent(value, digits = 2) {
        const sign = value > 0 ? "+" : "";
        return `${sign}${formatPercent(value, digits)}`;
    }

    function roundTo(value, digits) {
        const factor = 10 ** digits;
        return Math.round(value * factor) / factor;
    }
})();
