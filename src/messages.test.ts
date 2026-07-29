import { expect, test } from "bun:test";
import { LIVE, newCinemas, subscriptionAlert } from "./messages.ts";

const URL = "https://in.bookmyshow.com/movies/mumbai/foo/buytickets/ET00000001";

test("newCinemas lists venue names and uses LIVE alert colour", () => {
  const { embeds } = newCinemas({
    title: "The Odyssey",
    city: "mumbai",
    venues: [
      { code: "PVRJ", name: "PVR: Juhu" },
      { code: "MCIW", name: "Miraj Cinemas: IMAX, Wadala" },
    ],
    url: URL,
  });
  const embed = embeds[0]!.data;
  expect(embed.color).toBe(LIVE);
  expect(embed.title).toBe("The Odyssey — 2 new cinemas");
  expect(embed.description).toContain("PVR: Juhu");
  expect(embed.description).toContain("Miraj Cinemas: IMAX, Wadala");
  expect(embed.description).toContain("Mumbai");
});

test("subscriptionAlert combines dates and cinemas when both present", () => {
  const { embeds } = subscriptionAlert({
    title: "The Odyssey",
    city: "mumbai",
    dates: ["20260728", "20260730"],
    venues: [{ code: "PVRJ", name: "PVR: Juhu" }],
    url: URL,
  });
  const embed = embeds[0]!.data;
  expect(embed.title).toBe("The Odyssey — new dates & cinemas");
  expect(embed.fields?.[0]?.name).toBe("New dates");
  expect(embed.fields?.[1]?.name).toBe("New cinemas");
  expect(embed.fields?.[1]?.value).toContain("PVR: Juhu");
});

test("subscriptionAlert delegates to newCinemas when only venues", () => {
  const { embeds } = subscriptionAlert({
    title: "The Odyssey",
    city: "mumbai",
    dates: [],
    venues: [{ code: "PVRJ", name: "PVR: Juhu" }],
    url: URL,
  });
  expect(embeds[0]!.data.title).toBe("The Odyssey — new cinema");
});
