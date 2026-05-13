import OperatorConsole from "@/components/OperatorConsole";
import { catalog } from "@/lib/data";

export default function Page() {
  return <OperatorConsole initialState={catalog} />;
}
