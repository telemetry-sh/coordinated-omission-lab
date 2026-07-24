import type { Metadata } from "next";
import { CoordinatedOmissionLab } from "../components/coordinated-omission-lab";

export const metadata: Metadata = {
  title: { absolute: "Coordinated Omission Lab" },
  description:
    "Compare closed-loop and open-loop load generation against the same overloaded service.",
};

export default function Home() {
  return <CoordinatedOmissionLab />;
}
