import { createFileRoute } from "@tanstack/react-router";
import { TicketDetail } from "../../TicketDetail.tsx";

export const Route = createFileRoute("/tickets/$ticketId")({
  component: TicketPage,
});

function TicketPage() {
  const { ticketId } = Route.useParams();
  const id = Number(ticketId);
  if (!Number.isInteger(id) || id < 1) {
    return (
      <p className="note" role="status">
        没有这个票
      </p>
    );
  }
  return <TicketDetail key={id} ticketId={id} />;
}
