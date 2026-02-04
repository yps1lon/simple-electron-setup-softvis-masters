import * as d3 from "d3";
// Read the documentation at https://d3js.org/getting-started

// When the DOM is loaded, create the visualization
window.addEventListener("DOMContentLoaded", () => {

  // Hardcoded data (you will replace this with loaded or generated data)
  const data = [5, 10, 15, 20, 25];

  // Set the dimensions and margins of the graph
  const width = 400;
  const height = 200;
  const margin = { top: 0, right: 0, bottom: 20, left: 20 }; // Needed for the axes to be visible

  // Create the parent SVG element - needed for SVG elements to be appended to it
  const svg = d3
    .select("#vis")
    .append("svg")
    .attr("width", width)
    .attr("height", height);

  // SCALES: https://d3js.org/d3-scale
  // Create the x scale
  const scaleX = d3
    .scaleBand()
    .domain(data.map((_, i) => i)) // 0, 1, 2, 3, 4
    .range([margin.left, width])
    .padding(0.1);

  // Create the y scale
  const scaleY = d3
    .scaleLinear()
    .domain([0, d3.max(data) || 0])
    .range([height - margin.bottom, 0]);

  // Create and append the bars to the SVG
  svg
    .selectAll("rect")
    .data(data)
    .enter()
    .append("rect")
    .attr("x", (_, i) => scaleX(i))
    .attr("y", d => scaleY(d))
    .attr("width", scaleX.bandwidth())
    .attr("height", d => scaleY(0) - scaleY(d))
    .attr("fill", "#4e79a7");

  // Create the x-axis
  const xAxis = g =>
    g
      .attr("transform", `translate(0,${height - margin.bottom})`)
      .call(d3.axisBottom(scaleX).tickFormat(i => i + 1));

  // Create the y-axis
  const yAxis = g =>
    g
      .attr("transform", `translate(${margin.left},0)`)
      .call(d3.axisLeft(scaleY).ticks(5));

  // Append the x-axis and y-axis to the SVG
  svg.append("g").call(xAxis);
  svg.append("g").call(yAxis);
});

