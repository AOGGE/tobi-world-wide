// @ts-check
import { module } from "@prisma/composer";
import tobiWorldWideService from "./service.mjs";

export default module("tobi-world-wide", ({ provision }) => {
  provision(tobiWorldWideService, { id: "tobiworldwide" });
});
