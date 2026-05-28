import { BrowserRouter, Routes, Route } from "react-router-dom";
import Upload from "./pages/Upload.jsx";
import Capsule from "./pages/Capsule.jsx";

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Upload />} />
        <Route path="/c/:id" element={<Capsule />} />
      </Routes>
    </BrowserRouter>
  );
}
