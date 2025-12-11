const fetch = require('node-fetch');

module.exports = async (req, res) => {
  // Enable CORS for all origins
  const origin = req.headers.origin || '*';
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Credentials', 'true');

  // Handle preflight request
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // Only allow POST requests
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { symbols, range = '1Y' } = req.body;
    
    if (!symbols || !Array.isArray(symbols) || symbols.length === 0) {
      return res.status(400).json({ 
        error: 'Stock symbols required', 
        usage: 'POST body: { symbols: ["AAPL", "GOOGL"], range: "1Y" }' 
      });
    }

    // Validate symbols (max 5 for comparison)
    if (symbols.length > 5) {
      return res.status(400).json({ 
        error: 'Maximum 5 symbols allowed for comparison' 
      });
    }

    // Fetch data for all symbols
    const stockDataPromises = symbols.map(symbol => fetchStockData(symbol, range));
    const stockDataResults = await Promise.allSettled(stockDataPromises);
    
    // Filter successful fetches
    const validStockData = [];
    const errors = [];
    
    stockDataResults.forEach((result, index) => {
      if (result.status === 'fulfilled' && result.value.success) {
        validStockData.push({
          symbol: symbols[index],
          data: result.value.data,
          debug: result.value.debug
        });
      } else {
        errors.push({
          symbol: symbols[index],
          error: result.reason || result.value.error
        });
      }
    });

    if (validStockData.length === 0) {
      return res.status(404).json({ 
        error: 'No valid stock data found',
        details: errors
      });
    }

    // Generate chart configuration
    const chartConfig = createChartConfig(validStockData, range);
    
    // Use QuickChart.io to generate the chart
    const quickChartUrl = 'https://quickchart.io/chart';
    const chartResponse = await fetch(quickChartUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        chart: chartConfig,
        width: 900,  // Slightly wider for more data points
        height: 450,  // Slightly taller
        devicePixelRatio: 2,
        backgroundColor: 'white',
        format: 'png'
      })
    });

    if (!chartResponse.ok) {
      throw new Error('Failed to generate chart from QuickChart');
    }

    // Get the image as base64
    const imageBuffer = await chartResponse.buffer();
    const base64Image = imageBuffer.toString('base64');
    
    // Return as JSON with base64 image and debug info
    res.status(200).json({
      success: true,
      image: `data:image/png;base64,${base64Image}`,
      symbols: validStockData.map(s => s.symbol),
      range: range,
      debug: validStockData.map(s => ({
        symbol: s.symbol,
        dataPoints: s.data.length,
        startDate: s.data[0]?.date,
        endDate: s.data[s.data.length - 1]?.date,
        startPrice: s.data[0]?.price,
        endPrice: s.data[s.data.length - 1]?.price
      }))
    });

  } catch (error) {
    console.error('Chart generation error:', error);
    return res.status(500).json({ 
      error: 'Failed to generate chart',
      message: error.message
    });
  }
};

async function fetchStockData(symbol, range) {
  try {
    // Get current time in milliseconds
    const now = Date.now();
    const nowUnix = Math.floor(now / 1000);
    
    // Calculate the start date based on range
    let period1;
    const msPerDay = 24 * 60 * 60 * 1000;
    
    switch (range) {
      case '1M':
        period1 = Math.floor((now - (30 * msPerDay)) / 1000);
        break;
      case '3M':
        period1 = Math.floor((now - (90 * msPerDay)) / 1000);
        break;
      case '6M':
        period1 = Math.floor((now - (182 * msPerDay)) / 1000);
        break;
      case '1Y':
        period1 = Math.floor((now - (365 * msPerDay)) / 1000);
        break;
      case '5Y':
        period1 = Math.floor((now - (5 * 365 * msPerDay)) / 1000);
        break;
      default:
        period1 = Math.floor((now - (365 * msPerDay)) / 1000);
    }

    // Always use the most granular interval available based on range
    let interval;
    if (range === '1M') {
      interval = '1h';  // Hourly data for 1 month (more detail)
    } else if (range === '3M') {
      interval = '1d';  // Daily data for 3 months
    } else if (range === '6M') {
      interval = '1d';  // Daily data for 6 months (about 130 trading days)
    } else if (range === '1Y') {
      interval = '1d';  // Daily data for 1 year (about 252 trading days)
    } else if (range === '5Y') {
      interval = '1wk'; // Weekly data for 5 years (daily would be too many points)
    } else {
      interval = '1d';  // Default to daily
    }

    // Fetch from Yahoo Finance API
    const yahooUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol.toUpperCase()}?period1=${period1}&period2=${nowUnix}&interval=${interval}&includePrePost=false&events=div%7Csplit`;
    
    console.log(`Fetching ${symbol} with interval ${interval} from: ${new Date(period1 * 1000).toISOString()} to ${new Date(nowUnix * 1000).toISOString()}`);
    
    const response = await fetch(yahooUrl);
    const data = await response.json();

    if (!response.ok || data.chart.error) {
      console.error(`Yahoo API error for ${symbol}:`, data.chart?.error);
      return {
        success: false,
        error: data.chart?.error?.description || 'Failed to fetch data'
      };
    }

    const result = data.chart.result[0];
    
    if (!result || !result.timestamp || !result.indicators?.quote?.[0]?.close) {
      console.error(`Invalid data structure for ${symbol}`);
      return {
        success: false,
        error: 'Invalid data structure received'
      };
    }
    
    const timestamps = result.timestamp;
    const prices = result.indicators.quote[0].close;
    const highs = result.indicators.quote[0].high;
    const lows = result.indicators.quote[0].low;
    const opens = result.indicators.quote[0].open;
    const volumes = result.indicators.quote[0].volume;

    // Create clean data, keeping track of null values
    const cleanData = [];
    let nullCount = 0;
    
    for (let i = 0; i < timestamps.length; i++) {
      if (prices[i] !== null && prices[i] !== undefined && !isNaN(prices[i])) {
        cleanData.push({
          date: new Date(timestamps[i] * 1000),
          price: parseFloat(prices[i].toFixed(2)),
          high: highs ? parseFloat(highs[i]?.toFixed(2) || prices[i].toFixed(2)) : prices[i],
          low: lows ? parseFloat(lows[i]?.toFixed(2) || prices[i].toFixed(2)) : prices[i],
          open: opens ? parseFloat(opens[i]?.toFixed(2) || prices[i].toFixed(2)) : prices[i],
          volume: volumes ? volumes[i] : 0
        });
      } else {
        nullCount++;
      }
    }

    // Sort by date to ensure correct order
    cleanData.sort((a, b) => a.date - b.date);

    console.log(`${symbol}: Fetched ${cleanData.length} data points with ${interval} interval (${nullCount} nulls removed)`);

    return {
      success: true,
      data: cleanData,
      debug: {
        totalPoints: timestamps.length,
        cleanPoints: cleanData.length,
        nullPoints: nullCount,
        interval: interval,
        dateRange: `${new Date(period1 * 1000).toLocaleDateString()} to ${new Date(nowUnix * 1000).toLocaleDateString()}`
      }
    };

  } catch (error) {
    console.error(`Error fetching ${symbol}:`, error);
    return {
      success: false,
      error: error.message
    };
  }
}

function createChartConfig(stockData, range) {
  // Prepare datasets
  const datasets = [];
  const colors = [
    'rgb(54, 162, 235)',   // Blue (changed from red for first stock)
    'rgb(255, 99, 132)',   // Red
    'rgb(75, 192, 192)',   // Teal
    'rgb(255, 206, 86)',   // Yellow
    'rgb(153, 102, 255)'   // Purple
  ];

  // Determine if this is a comparison chart
  const isComparison = stockData.length > 1;

  // For comparison charts, normalize to percentage change
  if (isComparison) {
    stockData.forEach((stock, index) => {
      if (stock.data.length === 0) return;
      
      const firstPrice = stock.data[0].price;
      const normalizedData = stock.data.map(point => ({
        x: point.date.toISOString(),
        y: ((point.price - firstPrice) / firstPrice) * 100
      }));

      datasets.push({
        label: stock.symbol,
        data: normalizedData,
        borderColor: colors[index % colors.length],
        backgroundColor: 'transparent',
        borderWidth: 2,
        fill: false,
        tension: 0.1,
        pointRadius: 0,  // Hide points for cleaner look with many data points
        pointHoverRadius: 4,
        pointHitRadius: 10  // Larger hit area for hover
      });
    });
  } else {
    // For single stock - show actual prices
    const stock = stockData[0];
    if (stock.data.length === 0) return {};
    
    const chartData = stock.data.map(point => ({
      x: point.date.toISOString(),
      y: point.price
    }));

    // Calculate min and max for better scaling
    const prices = stock.data.map(d => d.price);
    const minPrice = Math.min(...prices);
    const maxPrice = Math.max(...prices);
    const padding = (maxPrice - minPrice) * 0.05; // 5% padding

    datasets.push({
      label: `${stock.symbol} Price`,
      data: chartData,
      borderColor: colors[0],
      backgroundColor: colors[0] + '20',  // Very light fill
      borderWidth: 2,
      fill: true,
      tension: 0.1,
      pointRadius: 0,  // Hide points for cleaner look
      pointHoverRadius: 4,
      pointHitRadius: 10  // Larger hit area for hover
    });
  }

  // Determine time unit and display format based on range and data points
  let timeUnit = 'day';
  let displayFormat = 'MMM d';
  
  if (range === '1M') {
    // For 1 month with hourly data, show day labels
    timeUnit = 'day';
    displayFormat = 'MMM d';
  } else if (range === '3M' || range === '6M') {
    // For 3-6 months, show monthly labels
    timeUnit = 'month';
    displayFormat = 'MMM';
  } else if (range === '1Y') {
    // For 1 year, show monthly labels
    timeUnit = 'month';
    displayFormat = 'MMM yy';
  } else if (range === '5Y') {
    // For 5 years, show yearly labels
    timeUnit = 'year';
    displayFormat = 'yyyy';
  }

  // Create the chart configuration for QuickChart
  return {
    type: 'line',
    data: {
      datasets: datasets
    },
    options: {
      responsive: true,
      maintainAspectRatio: true,
      plugins: {
        legend: {
          display: true,
          position: 'top',
          labels: {
            font: {
              size: 13
            },
            usePointStyle: true,
            padding: 15
          }
        },
        title: {
          display: true,
          text: isComparison 
            ? `Stock Comparison - % Change (${range})`
            : `${stockData[0].symbol} Stock Price (${range})`,
          font: {
            size: 16,
            weight: 'bold'
          },
          padding: {
            top: 10,
            bottom: 20
          }
        },
        tooltip: {
          mode: 'index',
          intersect: false,
          backgroundColor: 'rgba(0,0,0,0.8)',
          titleFont: {
            size: 12
          },
          bodyFont: {
            size: 11
          },
          callbacks: {
            label: function(context) {
              let label = context.dataset.label || '';
              if (label) {
                label += ': ';
              }
              if (isComparison) {
                label += context.parsed.y.toFixed(2) + '%';
              } else {
                label += '$' + context.parsed.y.toFixed(2);
              }
              return label;
            }
          }
        }
      },
      scales: {
        x: {
          type: 'time',
          time: {
            unit: timeUnit,
            displayFormats: {
              hour: 'ha',
              day: displayFormat,
              week: displayFormat,
              month: displayFormat,
              year: displayFormat
            }
          },
          title: {
            display: true,
            text: 'Date',
            font: {
              size: 12
            }
          },
          grid: {
            display: true,
            drawOnChartArea: true,
            drawTicks: true,
            color: 'rgba(0, 0, 0, 0.05)'
          },
          ticks: {
            maxRotation: 45,
            minRotation: 0,
            autoSkip: true,
            autoSkipPadding: 10,
            font: {
              size: 10
            }
          }
        },
        y: {
          title: {
            display: true,
            text: isComparison ? 'Percentage Change (%)' : 'Price (USD)',
            font: {
              size: 12
            }
          },
          ticks: {
            callback: function(value) {
              if (isComparison) {
                return value.toFixed(1) + '%';
              } else {
                return '$' + value.toFixed(0);
              }
            },
            font: {
              size: 10
            }
          },
          grid: {
            color: 'rgba(0, 0, 0, 0.08)',
            drawTicks: true
          },
          // Add suggested min/max for single stock charts for better scaling
          ...(isComparison ? {} : {
            suggestedMin: stockData[0].data.length > 0 ? 
              Math.min(...stockData[0].data.map(d => d.price)) - 
              (Math.max(...stockData[0].data.map(d => d.price)) - Math.min(...stockData[0].data.map(d => d.price))) * 0.05 : undefined,
            suggestedMax: stockData[0].data.length > 0 ? 
              Math.max(...stockData[0].data.map(d => d.price)) + 
              (Math.max(...stockData[0].data.map(d => d.price)) - Math.min(...stockData[0].data.map(d => d.price))) * 0.05 : undefined
          })
        }
      },
      interaction: {
        mode: 'nearest',
        axis: 'x',
        intersect: false
      },
      elements: {
        line: {
          borderJoinStyle: 'round'
        }
      }
    }
  };
}