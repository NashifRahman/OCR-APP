const rawData = require('./data/eval.json');

const processedData = rawData.map(row => {
    const TP = Number(row.TP) || 0;
    const FP = Number(row.FP) || 0;
    const FN = Number(row.FN) || 0;
    const TN = Number(row.TN) || 0;
    const denominator = Math.sqrt((TP+FP)*(TP+FN)*(TN+FP)*(TN+FN))

    const accuracy = (TP+TN)?(TP+TN)/(TP+TN+FN+FP):0;
    const precision = (TP + FP) ? TP / (TP + FP) : 0;
    const recall = (TP + FN) ? TP / (TP + FN) : 0;
    const f1Score = (precision + recall)
        ? 2 * (precision * recall / (precision + recall))
        : 0;
    const MCC = denominator !== 0
        ? ((TP * TN) - (FP * FN)) / denominator
        : 0;

    return {
        ...row,
        Accuracy: Number(accuracy.toFixed(4)),
        Precision: Number(precision.toFixed(4)),
        Recall: Number(recall.toFixed(4)),
        "F1-Score": Number(f1Score.toFixed(4)),
        MCC: Number(MCC.toFixed(4))
    };
});

console.table(processedData);