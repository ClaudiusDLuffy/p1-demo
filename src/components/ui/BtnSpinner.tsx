export function BtnSpinner() {
  return (
    <span
      style={{
        display: "inline-block",
        width: 12,
        height: 12,
        border: "2px solid rgba(255,255,255,0.3)",
        borderTopColor: "#fff",
        borderRadius: "50%",
        animation: "spin 0.7s linear infinite",
        marginRight: 6,
        verticalAlign: "middle",
      }}
    />
  );
}

export function BtnSpinnerDark() {
  return (
    <span
      style={{
        display: "inline-block",
        width: 12,
        height: 12,
        border: "2px solid rgba(31,30,28,0.2)",
        borderTopColor: "#1F1E1C",
        borderRadius: "50%",
        animation: "spin 0.7s linear infinite",
        marginRight: 6,
        verticalAlign: "middle",
      }}
    />
  );
}
