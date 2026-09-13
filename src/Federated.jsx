import React from "react";
import Panel from "./Panel";
import css from "./style.css";
export default function Federated(props) {
  return (
    <>
      <style>{css}</style>
      <Panel {...props} />
    </>
  );
}
