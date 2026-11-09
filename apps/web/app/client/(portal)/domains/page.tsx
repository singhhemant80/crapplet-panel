"use client";
import Link from "next/link";
import { date } from "@/lib/api";
import { Badge, Button, Card, Empty, Loading, PageHeader, Table, Td, useApi } from "@/components/ui";

export default function Domains() {
  const { data, loading } = useApi("/client/domains");
  return (
    <>
      <PageHeader title="Domains" actions={<Button href="/order/domain" icon="travel_explore">Register a domain</Button>} />
      <Card pad={false}>
        {loading ? (
          <Loading />
        ) : !data?.domains.length ? (
          <Empty icon="language" title="No domains yet">
            Search for your perfect .in or .com domain.
          </Empty>
        ) : (
          <Table head={["Domain", "Status", "Registered", "Expires", "Auto-renew", ""]}>
            {data.domains.map((d: any) => (
              <tr key={d.id} className="hover:bg-primary-tint">
                <Td className="font-bold text-ink">{d.name}</Td>
                <Td><Badge status={d.status} /></Td>
                <Td className="text-mute">{date(d.registrationDate)}</Td>
                <Td className="text-mute">{date(d.expiryDate)}</Td>
                <Td>{d.autoRenew ? "On" : "Off"}</Td>
                <Td className="text-right"><Link href={`/client/domains/${d.id}`} className="font-bold text-primary-dark hover:underline">Manage</Link></Td>
              </tr>
            ))}
          </Table>
        )}
      </Card>
    </>
  );
}
