import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import "./shared/tokens.css";
import "./shared/components.css";
import "./styles.css";

function useStageScale() {
  const [scale, setScale] = useState(1);

  useEffect(() => {
    const update = () => {
      const widthScale = window.innerWidth / 1536;
      const heightScale = window.innerHeight / 1024;
      setScale(Math.min(widthScale, heightScale));
    };
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);

  return useMemo(() => ({ "--stage-scale": scale }), [scale]);
}

function Root() {
  const scaleStyle = useStageScale();
  return (
    <div className="viewport-lock">
      <div className="stage-wrap" style={scaleStyle}>
        <div className="stage">
          <App />
        </div>
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")).render(<Root />);
