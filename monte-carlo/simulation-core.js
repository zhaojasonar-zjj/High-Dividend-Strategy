/*
 * 多资产组合蒙特卡洛仿真核心。
 * 该文件同时支持浏览器全局对象与 Node.js 单元测试，不依赖 DOM。
 */
(function attachMonteCarloCore(root, factory) {
    if (typeof module === "object" && module.exports) {
        module.exports = factory();
    } else {
        root.MCSimCore = factory();
    }
})(typeof self !== "undefined" ? self : globalThis, function createCore() {
    "use strict";

    const EPSILON = 1e-12;

    function isFiniteNumber(value) {
        return typeof value === "number" && Number.isFinite(value);
    }

    function clamp(value, min, max) {
        return Math.min(max, Math.max(min, value));
    }

    /** Mulberry32：轻量、确定性的伪随机数发生器。 */
    function mulberry32(seed) {
        let state = seed >>> 0;
        return function nextRandom() {
            state = (state + 0x6D2B79F5) >>> 0;
            let t = state;
            t = Math.imul(t ^ (t >>> 15), t | 1);
            t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
    }

    /** Box-Muller，并缓存配对正态样本，避免浪费一个随机数。 */
    function createGaussianGenerator(rng) {
        let hasSpare = false;
        let spare = 0;
        return function gaussianRandom() {
            if (hasSpare) {
                hasSpare = false;
                return spare;
            }

            let u = 0;
            let v = 0;
            do {
                u = rng();
            } while (u <= 0);
            v = rng();

            const magnitude = Math.sqrt(-2 * Math.log(u));
            const angle = 2 * Math.PI * v;
            spare = magnitude * Math.sin(angle);
            hasSpare = true;
            return magnitude * Math.cos(angle);
        };
    }

    /** Marsaglia–Tsang Gamma 采样，用于构造任意小数自由度的卡方变量。 */
    function gammaRandom(shape, rng, gaussian) {
        if (shape <= 0) return 0;
        if (shape < 1) {
            return gammaRandom(shape + 1, rng, gaussian) * Math.pow(rng(), 1 / shape);
        }

        const d = shape - 1 / 3;
        const c = 1 / Math.sqrt(9 * d);
        for (;;) {
            const x = gaussian();
            const base = 1 + c * x;
            if (base <= 0) continue;
            const v = base * base * base;
            const u = Math.max(rng(), Number.MIN_VALUE);
            if (Math.log(u) < 0.5 * x * x + d - d * v + d * Math.log(v)) {
                return d * v;
            }
        }
    }

    /** Knuth 泊松采样。此处 λΔt 通常远小于 1，适合逐日频率。 */
    function poissonRandom(lambda, rng) {
        if (lambda <= 0) return 0;
        const threshold = Math.exp(-lambda);
        let k = 0;
        let product = 1;
        do {
            k += 1;
            product *= rng();
        } while (product > threshold && k < 10000);
        return k - 1;
    }

    function cloneMatrix(matrix) {
        return matrix.map((row) => row.slice());
    }

    /** 容差版 Cholesky，支持数学上的半正定矩阵。 */
    function choleskyDecomposition(matrix) {
        const n = matrix.length;
        const lower = Array.from({ length: n }, () => Array(n).fill(0));

        for (let i = 0; i < n; i += 1) {
            for (let j = 0; j <= i; j += 1) {
                let sum = 0;
                for (let k = 0; k < j; k += 1) {
                    sum += lower[i][k] * lower[j][k];
                }

                if (i === j) {
                    const diagonal = matrix[i][i] - sum;
                    if (diagonal < -1e-8) return null;
                    lower[i][j] = Math.sqrt(Math.max(0, diagonal));
                } else {
                    const numerator = matrix[i][j] - sum;
                    if (lower[j][j] <= 1e-10) {
                        if (Math.abs(numerator) > 1e-8) return null;
                        lower[i][j] = 0;
                    } else {
                        lower[i][j] = numerator / lower[j][j];
                    }
                }
            }
        }
        return lower;
    }

    /** Jacobi 特征分解，适用于资产数量较少且矩阵对称的场景。 */
    function jacobiEigen(matrix) {
        const n = matrix.length;
        const a = cloneMatrix(matrix);
        const vectors = Array.from({ length: n }, (_, i) => {
            const row = Array(n).fill(0);
            row[i] = 1;
            return row;
        });

        for (let sweep = 0; sweep < 120; sweep += 1) {
            let offDiagonal = 0;
            for (let i = 0; i < n; i += 1) {
                for (let j = i + 1; j < n; j += 1) {
                    offDiagonal += Math.abs(a[i][j]);
                }
            }
            if (offDiagonal < 1e-12) break;

            for (let p = 0; p < n - 1; p += 1) {
                for (let q = p + 1; q < n; q += 1) {
                    const apq = a[p][q];
                    if (Math.abs(apq) < 1e-14) continue;

                    const app = a[p][p];
                    const aqq = a[q][q];
                    const tau = (aqq - app) / (2 * apq);
                    const sign = tau >= 0 ? 1 : -1;
                    const t = sign / (Math.abs(tau) + Math.sqrt(1 + tau * tau));
                    const c = 1 / Math.sqrt(1 + t * t);
                    const s = t * c;

                    for (let k = 0; k < n; k += 1) {
                        if (k === p || k === q) continue;
                        const akp = a[k][p];
                        const akq = a[k][q];
                        a[k][p] = c * akp - s * akq;
                        a[p][k] = a[k][p];
                        a[k][q] = s * akp + c * akq;
                        a[q][k] = a[k][q];
                    }

                    a[p][p] = app - t * apq;
                    a[q][q] = aqq + t * apq;
                    a[p][q] = 0;
                    a[q][p] = 0;

                    for (let k = 0; k < n; k += 1) {
                        const vkp = vectors[k][p];
                        const vkq = vectors[k][q];
                        vectors[k][p] = c * vkp - s * vkq;
                        vectors[k][q] = s * vkp + c * vkq;
                    }
                }
            }
        }

        return {
            values: a.map((row, i) => row[i]),
            vectors
        };
    }

    function normalizeCorrelationMatrix(matrix) {
        const n = matrix.length;
        const result = cloneMatrix(matrix);

        for (let i = 0; i < n; i += 1) {
            for (let j = i + 1; j < n; j += 1) {
                const average = (result[i][j] + result[j][i]) / 2;
                result[i][j] = average;
                result[j][i] = average;
            }
        }

        const scales = result.map((row, index) => Math.sqrt(Math.max(row[index], EPSILON)));
        for (let i = 0; i < n; i += 1) {
            for (let j = 0; j < n; j += 1) {
                result[i][j] /= scales[i] * scales[j];
            }
            result[i][i] = 1;
        }
        return result;
    }

    /**
     * 将轻微违反半正定性的相关矩阵投影到附近的有效相关矩阵。
     * 方法：特征值截断为 ≥ 0 后重建，并重新把对角线归一为 1，迭代至收敛。
     */
    function nearestCorrelationMatrix(matrix) {
        if (!Array.isArray(matrix) || matrix.length === 0) {
            return { ok: false, message: "相关矩阵不能为空。" };
        }
        const n = matrix.length;
        for (const row of matrix) {
            if (!Array.isArray(row) || row.length !== n || row.some((v) => !isFiniteNumber(v))) {
                return { ok: false, message: "相关矩阵必须为有限数值方阵。" };
            }
        }

        let current = normalizeCorrelationMatrix(matrix);
        let adjusted = false;
        let minimumEigenvalue = Infinity;

        for (let iteration = 0; iteration < 20; iteration += 1) {
            const eigen = jacobiEigen(current);
            minimumEigenvalue = Math.min(...eigen.values);
            if (minimumEigenvalue >= -1e-10) break;

            adjusted = true;
            const clipped = eigen.values.map((value) => Math.max(value, 1e-10));
            const rebuilt = Array.from({ length: n }, () => Array(n).fill(0));

            for (let k = 0; k < n; k += 1) {
                for (let i = 0; i < n; i += 1) {
                    const scaledVector = eigen.vectors[i][k] * clipped[k];
                    for (let j = 0; j < n; j += 1) {
                        rebuilt[i][j] += scaledVector * eigen.vectors[j][k];
                    }
                }
            }
            current = normalizeCorrelationMatrix(rebuilt);
        }

        const finalEigen = jacobiEigen(current);
        minimumEigenvalue = Math.min(...finalEigen.values);
        const cholesky = choleskyDecomposition(current);
        if (!cholesky || minimumEigenvalue < -1e-7) {
            return {
                ok: false,
                adjusted,
                minEigenvalue: minimumEigenvalue,
                message: "无法把当前输入修复为有效的半正定相关矩阵，请降低互相矛盾的高相关性。"
            };
        }

        return {
            ok: true,
            matrix: current,
            cholesky,
            adjusted,
            minEigenvalue: minimumEigenvalue,
            message: adjusted ? "已自动投影为最近的半正定相关矩阵。" : "相关矩阵通过半正定校验。"
        };
    }

    /** 核心模拟。所有权重必须为小数且总和为 1。 */
    function simulatePortfolio(config, onProgress) {
        const assets = config.assets;
        const nAssets = assets.length;
        const days = config.days;
        const paths = config.paths;
        const initialValue = config.initialValue || 100;
        const dt = 1 / 252;
        const sqrtDt = Math.sqrt(dt);
        const useJump = config.model === "JUMP" || config.model === "STUDENT_T_JUMP";
        const useStudentT = config.model === "STUDENT_T" || config.model === "STUDENT_T_JUMP";
        const studentDf = Math.max(2.000001, (config.student && config.student.df) || 5);
        const maxStandardizedShock = 10;
        const buyHold = config.holdingMode !== "dailyRebalance";
        const rng = mulberry32(config.seed >>> 0);
        const gaussian = createGaussianGenerator(rng);
        const cholesky = config.cholesky;

        const weights = new Float64Array(nAssets);
        const drift = new Float64Array(nAssets);
        const diffusion = new Float64Array(nAssets);
        const jump = config.jump || {};
        const jumpLambda = useJump ? Math.max(0, jump.lambda || 0) : 0;
        const jumpMu = jump.mu || 0;
        const jumpSigma = Math.max(0, jump.sigma || 0);
        const jumpCorrelation = clamp(jump.correlation || 0, 0, 1);
        const kappa = Math.exp(jumpMu + 0.5 * jumpSigma * jumpSigma) - 1;
        const systemicLambda = jumpLambda * jumpCorrelation;
        const idiosyncraticLambda = jumpLambda * (1 - jumpCorrelation);

        for (let i = 0; i < nAssets; i += 1) {
            weights[i] = assets[i].weight;
            const sigma = assets[i].sigma;
            const baseDrift = assets[i].mu - 0.5 * sigma * sigma;
            drift[i] = (baseDrift - (useJump ? jumpLambda * kappa : 0)) * dt;
            diffusion[i] = sigma * sqrtDt;
        }

        const finalValues = new Float64Array(paths);
        const maxDrawdowns = new Float64Array(paths);
        const chartPathCount = Math.min(50, paths);
        const chartPaths = Array.from({ length: chartPathCount }, () => new Float64Array(days + 1));
        const independentZ = new Float64Array(nAssets);
        const correlatedX = new Float64Array(nAssets);
        const relativePrices = new Float64Array(nAssets);
        const grossReturns = new Float64Array(nAssets);
        const progressInterval = Math.max(1, Math.floor(paths / 100));

        // 对偶变差（Antithetic Variates）：将路径配对，配对路径使用相同随机数的相反符号。
        // 仅对对称分布分量（Gaussian / Student-t 正态部分）取反；跳跃计数和卡方分母保持独立。
        const antitheticPairs = Math.floor(paths / 2);
        const hasOddPath = (paths % 2) === 1;

        function simulateOnePath(pathIndex, negateShock) {
            relativePrices.fill(1);
            let portfolioValue = initialValue;
            let runningPeak = initialValue;
            let pathMaxDrawdown = 0;

            if (pathIndex < chartPathCount) chartPaths[pathIndex][0] = portfolioValue;

            for (let day = 1; day <= days; day += 1) {
                for (let i = 0; i < nAssets; i += 1) independentZ[i] = gaussian();

                for (let i = 0; i < nAssets; i += 1) {
                    let sum = 0;
                    const row = cholesky[i];
                    for (let k = 0; k <= i; k += 1) sum += row[k] * independentZ[k];
                    correlatedX[i] = sum;
                }

                if (useStudentT) {
                    const chiSquare = 2 * gammaRandom(studentDf / 2, rng, gaussian);
                    const studentScale = Math.sqrt((studentDf - 2) / Math.max(chiSquare, EPSILON));
                    for (let i = 0; i < nAssets; i += 1) {
                        correlatedX[i] = clamp(
                            correlatedX[i] * studentScale,
                            -maxStandardizedShock,
                            maxStandardizedShock
                        );
                    }
                }

                // 对偶变差：对 Gaussian 衍生的冲击取反
                if (negateShock) {
                    for (let i = 0; i < nAssets; i += 1) correlatedX[i] = -correlatedX[i];
                }

                let systemicJump = 0;
                if (useJump && systemicLambda > 0) {
                    const jumpCount = poissonRandom(systemicLambda * dt, rng);
                    for (let j = 0; j < jumpCount; j += 1) {
                        const jumpShock = jumpMu + jumpSigma * gaussian();
                        systemicJump += negateShock ? -jumpShock + 2 * jumpMu : jumpShock;
                    }
                }

                for (let i = 0; i < nAssets; i += 1) {
                    let idiosyncraticJump = 0;
                    if (useJump && idiosyncraticLambda > 0) {
                        const jumpCount = poissonRandom(idiosyncraticLambda * dt, rng);
                        for (let j = 0; j < jumpCount; j += 1) {
                            const jumpShock = jumpMu + jumpSigma * gaussian();
                            idiosyncraticJump += negateShock ? -jumpShock + 2 * jumpMu : jumpShock;
                        }
                    }

                    const logReturn = drift[i] + diffusion[i] * correlatedX[i] + systemicJump + idiosyncraticJump;
                    const grossReturn = Math.exp(clamp(logReturn, -700, 700));
                    if (buyHold) {
                        relativePrices[i] *= grossReturn;
                    } else {
                        grossReturns[i] = grossReturn;
                    }
                }

                if (buyHold) {
                    portfolioValue = 0;
                    for (let i = 0; i < nAssets; i += 1) {
                        portfolioValue += initialValue * weights[i] * relativePrices[i];
                    }
                } else {
                    let portfolioGrossReturn = 0;
                    for (let i = 0; i < nAssets; i += 1) {
                        portfolioGrossReturn += weights[i] * grossReturns[i];
                    }
                    portfolioValue *= portfolioGrossReturn;
                }

                if (portfolioValue > runningPeak) runningPeak = portfolioValue;
                if (runningPeak > 0) {
                    const drawdown = 1 - portfolioValue / runningPeak;
                    if (drawdown > pathMaxDrawdown) pathMaxDrawdown = drawdown;
                } else {
                    pathMaxDrawdown = 1;
                }

                if (pathIndex < chartPathCount) chartPaths[pathIndex][day] = portfolioValue;
            }

            finalValues[pathIndex] = isFiniteNumber(portfolioValue) ? portfolioValue : 0;
            maxDrawdowns[pathIndex] = isFiniteNumber(pathMaxDrawdown) ? pathMaxDrawdown : 1;
        }

        for (let pair = 0; pair < antitheticPairs; pair += 1) {
            const idxBase = pair * 2;
            simulateOnePath(idxBase, false);
            simulateOnePath(idxBase + 1, true);

            if (typeof onProgress === "function" && ((idxBase + 2) % progressInterval === 0 || idxBase + 2 === paths)) {
                onProgress((idxBase + 2) / paths);
            }
        }

        if (hasOddPath) {
            simulateOnePath(paths - 1, false);
            if (typeof onProgress === "function") onProgress(1);
        }

        return {
            finalValues,
            maxDrawdowns,
            chartPaths,
            initialValue,
            seed: config.seed >>> 0,
            calibration: {
                model: config.model,
                studentDf,
                varianceScale: useStudentT ? Math.sqrt((studentDf - 2) / studentDf) : 1,
                jumpLambda: useJump ? jumpLambda : 0,
                jumpMu: useJump ? jumpMu : 0,
                jumpSigma: useJump ? jumpSigma : 0,
                kappa: useJump ? kappa : 0,
                driftCompensation: useJump ? jumpLambda * kappa : 0,
                assetDrifts: assets.map(function (a) {
                    return {
                        name: a.name,
                        mu: a.mu,
                        effectiveDrift: a.mu - (useJump ? jumpLambda * kappa : 0)
                    };
                }),
                antitheticVariates: true
            }
        };
    }

    function quantile(sortedValues, probability) {
        const n = sortedValues.length;
        if (n === 0) return NaN;
        if (n === 1) return sortedValues[0];
        const position = (n - 1) * probability;
        const lower = Math.floor(position);
        const upper = Math.ceil(position);
        const weight = position - lower;
        return sortedValues[lower] * (1 - weight) + sortedValues[upper] * weight;
    }

    function tailMean(sortedValues, cutoff) {
        let sum = 0;
        let count = 0;
        const tolerance = Math.max(1e-10, Math.abs(cutoff) * 1e-12);
        for (let i = 0; i < sortedValues.length; i += 1) {
            if (sortedValues[i] <= cutoff + tolerance) {
                sum += sortedValues[i];
                count += 1;
            } else {
                break;
            }
        }
        return count > 0 ? sum / count : sortedValues[0];
    }

    function calculateMetrics(finalValues, maxDrawdowns, initialValue) {
        const filtered = Array.from(finalValues).filter(isFiniteNumber);
        const n = filtered.length;
        if (n === 0) {
            return {
                count: 0,
                initialValue,
                mean: NaN,
                expectedReturn: NaN,
                median: NaN,
                standardDeviation: NaN,
                minimum: NaN,
                maximum: NaN,
                probabilityOfLoss: NaN,
                meanMaxDrawdown: NaN,
                worstMaxDrawdown: NaN,
                var95: NaN,
                var99: NaN,
                cvar95: NaN,
                cvar99: NaN,
                quantile05: NaN,
                quantile01: NaN
            };
        }
        const sorted = filtered.sort((a, b) => a - b);
        const mean = sorted.reduce((sum, value) => sum + value, 0) / n;
        let squaredError = 0;
        let lossCount = 0;

        for (const value of filtered) {
            squaredError += (value - mean) * (value - mean);
            if (value < initialValue) lossCount += 1;
        }

        const q05 = quantile(sorted, 0.05);
        const q01 = quantile(sorted, 0.01);
        const tail05 = tailMean(sorted, q05);
        const tail01 = tailMean(sorted, q01);
        const drawdowns = Array.from(maxDrawdowns).filter(isFiniteNumber);
        const meanMaxDrawdown = drawdowns.length > 0
            ? drawdowns.reduce((sum, value) => sum + value, 0) / drawdowns.length
            : 0;
        const worstMaxDrawdown = drawdowns.length > 0
            ? Math.max(...drawdowns)
            : 0;

        return {
            count: n,
            initialValue,
            mean,
            expectedReturn: mean / initialValue - 1,
            median: quantile(sorted, 0.5),
            standardDeviation: n > 1 ? Math.sqrt(squaredError / (n - 1)) : 0,
            minimum: sorted[0],
            maximum: sorted[n - 1],
            probabilityOfLoss: lossCount / n,
            meanMaxDrawdown,
            worstMaxDrawdown,
            var95: Math.max(0, initialValue - q05),
            var99: Math.max(0, initialValue - q01),
            cvar95: Math.max(0, initialValue - tail05),
            cvar99: Math.max(0, initialValue - tail01),
            quantile05: q05,
            quantile01: q01
        };
    }

    function buildHistogram(values, binCount) {
        const bins = Math.max(5, binCount || 30);
        let min = Infinity;
        let max = -Infinity;
        for (const value of values) {
            if (value < min) min = value;
            if (value > max) max = value;
        }

        if (!Number.isFinite(min) || !Number.isFinite(max)) {
            return { labels: [], counts: [] };
        }

        if (Math.abs(max - min) < 1e-10) {
            const padding = Math.max(0.01, Math.abs(min) * 0.001);
            min -= padding;
            max += padding;
        }

        const width = (max - min) / bins;
        const counts = Array(bins).fill(0);
        const labels = Array.from({ length: bins }, (_, i) => {
            const left = min + i * width;
            const right = left + width;
            return `${left.toFixed(1)}–${right.toFixed(1)}`;
        });

        for (const value of values) {
            let index = Math.floor((value - min) / width);
            index = clamp(index, 0, bins - 1);
            counts[index] += 1;
        }
        return { labels, counts };
    }

    /** 用核心函数的源码动态构造 Worker，保持项目无需打包、无需额外服务。 */
    function createWorkerSource() {
        const dependencies = [
            isFiniteNumber,
            mulberry32,
            createGaussianGenerator,
            gammaRandom,
            poissonRandom,
            clamp,
            simulatePortfolio
        ].map((fn) => fn.toString()).join("\n\n");

        return `const EPSILON = ${EPSILON};\n\n${dependencies}\n\n` + `
self.onmessage = function handleSimulationMessage(event) {
    try {
        const result = simulatePortfolio(event.data, function reportProgress(progress) {
            self.postMessage({ type: "progress", progress });
        });
        const transfer = [result.finalValues.buffer, result.maxDrawdowns.buffer]
            .concat(result.chartPaths.map(function (path) { return path.buffer; }));
        self.postMessage({ type: "result", result }, transfer);
    } catch (error) {
        self.postMessage({
            type: "error",
            message: error && error.message ? error.message : String(error)
        });
    }
};`;
    }

    function createSimulationWorker() {
        if (typeof Worker === "undefined" || typeof Blob === "undefined" || typeof URL === "undefined") {
            return null;
        }
        const source = createWorkerSource();
        const blob = new Blob([source], { type: "application/javascript" });
        const objectUrl = URL.createObjectURL(blob);
        const worker = new Worker(objectUrl);
        let revoked = false;
        const revoke = () => {
            if (!revoked) {
                revoked = true;
                URL.revokeObjectURL(objectUrl);
            }
        };
        worker.addEventListener("error", revoke, { once: true });
        worker.addEventListener("message", revoke, { once: true });
        return worker;
    }

    return {
        EPSILON,
        isFiniteNumber,
        clamp,
        mulberry32,
        createGaussianGenerator,
        gammaRandom,
        poissonRandom,
        choleskyDecomposition,
        jacobiEigen,
        nearestCorrelationMatrix,
        simulatePortfolio,
        quantile,
        calculateMetrics,
        buildHistogram,
        createWorkerSource,
        createSimulationWorker
    };
});
