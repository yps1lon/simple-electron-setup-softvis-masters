import * as d3 from "d3";

window.addEventListener("DOMContentLoaded", () => {
  const data = [5, 10, 15, 20, 25];

  const width = 400;
  const height = 200;
  const margin = { top: 20, right: 20, bottom: 30, left: 30 };

  const svg = d3
    .select("#viz")
    .append("svg")
    .attr("width", width)
    .attr("height", height);

  const x = d3
    .scaleBand()
    .domain(data.map((_, i) => i))
    .range([margin.left, width - margin.right])
    .padding(0.1);

  const y = d3
    .scaleLinear()
    .domain([0, d3.max(data) || 0])
    .nice()
    .range([height - margin.bottom, margin.top]);

  svg
    .selectAll("rect")
    .data(data)
    .enter()
    .append("rect")
    .attr("x", (_, i) => x(i))
    .attr("y", d => y(d))
    .attr("width", x.bandwidth())
    .attr("height", d => y(0) - y(d))
    .attr("fill", "#4e79a7");

  const xAxis = g =>
    g
      .attr("transform", `translate(0,${height - margin.bottom})`)
      .call(d3.axisBottom(x).tickFormat(i => i + 1));

  const yAxis = g =>
    g
      .attr("transform", `translate(${margin.left},0)`)
      .call(d3.axisLeft(y).ticks(5));

  svg.append("g").call(xAxis);
  svg.append("g").call(yAxis);
});

